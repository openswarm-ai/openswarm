"""Web tools: WebSearch and WebFetch."""

from __future__ import annotations

import html
import re

import httpx

from backend.apps.agents.tools.base import BaseTool
from backend.apps.agents.tools.ssrf_guard import SSRFBlocked, safe_fetch

_HTTP_TIMEOUT = 30
_MAX_OUTPUT_BYTES = 250 * 1024  # ~250 KB covers ~95% of articles/wikis/docs.
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


class DDGRateLimited(Exception):
    """DuckDuckGo answered with its throttle challenge (HTTP 202), not results.

    Distinct from 'genuinely zero hits' so the caller can fail over to another
    backend instead of reporting an empty search to the user. The throttle is
    per-IP and burst-triggered; a quick retry on the same or the `lite` endpoint
    does NOT clear it (both share the limiter), so the only cure is a different
    backend or waiting it out."""

def anthropic_web_search_is_reliable(*, uses_direct_anthropic_api: bool,
                                     is_pro: bool) -> bool:
    """Whether the CLI's built-in WebSearch is reliable enough to suppress the
    DuckDuckGo fallback. The built-in tool fires an aux `claude-haiku` call, and
    that call only authenticates when it reaches an ENTITLED Anthropic endpoint:

      - `uses_direct_anthropic_api`: the session is pinned to a direct Anthropic
        api-route model (base_url = api.anthropic.com with the user's own key),
        so the haiku call hits Anthropic directly and works.
      - `is_pro`: OpenSwarm Pro, entitled to the managed `anthropic` pool that
        9Router's `anthropic/*` route resolves to.

    A bare `anthropic_api_key` in settings is NOT sufficient: a SUBSCRIPTION-route
    Claude model (e.g. `opus-4-8`, route=None) still sends the haiku call through
    9Router to the managed pool, which 401s for non-Pro users ('Invalid bearer
    token, reset after ~2m'). Only a `*-api` route model talks to Anthropic
    directly. Everyone else keeps the free, always-working DDG path."""
    return bool(uses_direct_anthropic_api or is_pro)


def _truncate(text: str, limit: int = _MAX_OUTPUT_BYTES) -> str:
    if len(text) > limit:
        return text[:limit] + "\n... (output truncated)"
    return text


def _strip_html(raw_html: str) -> str:
    """Naive but effective HTML to plain-text conversion."""
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", raw_html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


class WebSearchTool(BaseTool):
    name = "WebSearch"
    description = (
        "Search the web using DuckDuckGo and return titles, URLs, and "
        "snippets for the top results."
    )

    def get_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query.",
                },
                "num_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default 5).",
                    "default": 5,
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        }

    async def execute(self, input_data: dict) -> list[dict]:
        query: str = input_data["query"]
        num_results: int = input_data.get("num_results", 5)

        try:
            results = await self._search_ddg(query, num_results)
            if not results:
                return [{"type": "text", "text": f"No search results found for: {query}"}]
            return [{"type": "text", "text": results}]
        except DDGRateLimited:
            return [{"type": "text", "text": (
                "DuckDuckGo is rate-limiting this network right now (HTTP 202). "
                "Wait a bit and retry, or use a different search source."
            )}]
        except Exception as exc:
            return [{"type": "text", "text": f"Web search error: {exc}"}]

    @staticmethod
    async def _search_ddg(query: str, num_results: int) -> str:
        """Query DuckDuckGo HTML endpoint and parse results."""
        async with httpx.AsyncClient(
            timeout=_HTTP_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": _USER_AGENT},
        ) as client:
            resp = await client.post(
                "https://html.duckduckgo.com/html/",
                data={"q": query},
            )
            # DDG serves its throttle challenge as 202 (a ~14KB no-results page),
            # which is a 2xx so raise_for_status() sails right past it. Catch it
            # explicitly so we report "rate-limited" instead of a bogus "no hits".
            if resp.status_code == 202:
                raise DDGRateLimited(query)
            resp.raise_for_status()

        body = resp.text

        result_blocks = re.findall(
            r'<div[^>]*class="[^"]*result[^"]*"[^>]*>(.*?)</div>\s*(?=<div[^>]*class="[^"]*result|$)',
            body,
            flags=re.DOTALL,
        )

        entries: list[str] = []
        for block in result_blocks:
            if len(entries) >= num_results:
                break

            # Handle both class-before-href and href-before-class attribute orders.
            link_match = re.search(
                r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
                block,
                flags=re.DOTALL,
            )
            if not link_match:
                link_match = re.search(
                    r'<a[^>]*href="([^"]*)"[^>]*class="[^"]*result__a[^"]*"[^>]*>(.*?)</a>',
                    block,
                    flags=re.DOTALL,
                )
            if not link_match:
                continue

            raw_url = html.unescape(link_match.group(1))

            # Drop sponsored rows: DDG ads point at its own y.js click-tracker
            # (ad_domain/ad_provider) instead of a real uddg= redirect, so they'd
            # otherwise show up as junk "duckduckgo.com/y.js?ad_..." results.
            if "/y.js?" in raw_url or "ad_provider=" in raw_url or "ad_domain=" in raw_url:
                continue

            title = _strip_html(link_match.group(2)).strip()

            snippet_match = re.search(
                r'<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>',
                block,
                flags=re.DOTALL,
            )
            snippet = _strip_html(snippet_match.group(1)).strip() if snippet_match else ""

            # DDG wraps URLs in a redirect; extract the real one.
            real_url_match = re.search(r"uddg=([^&]+)", raw_url)
            if real_url_match:
                from urllib.parse import unquote
                url = unquote(real_url_match.group(1))
            else:
                url = raw_url

            entry = f"[{len(entries) + 1}] {title}\n    {url}"
            if snippet:
                entry += f"\n    {snippet}"
            entries.append(entry)

        return "\n\n".join(entries)


class WebFetchTool(BaseTool):
    name = "WebFetch"
    description = (
        "Fetch the contents of a URL and return the extracted text. "
        "HTML is stripped to plain text. Output capped at ~250 KB."
    )

    def get_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to fetch.",
                },
                "prompt": {
                    "type": "string",
                    "description": "Optional prompt/context describing what information to look for.",
                },
            },
            "required": ["url"],
            "additionalProperties": False,
        }

    async def execute(self, input_data: dict) -> list[dict]:
        url: str = input_data["url"]
        prompt: str | None = input_data.get("prompt")

        try:
            resp = await safe_fetch(
                url,
                method="GET",
                headers={"User-Agent": _USER_AGENT},
                timeout=_HTTP_TIMEOUT,
            )
            resp.raise_for_status()
        except SSRFBlocked as exc:
            return [{"type": "text", "text": f"Refused to fetch {url}: {exc}"}]
        except httpx.HTTPStatusError as exc:
            return [{"type": "text", "text": f"HTTP error {exc.response.status_code} fetching {url}"}]
        except Exception as exc:
            return [{"type": "text", "text": f"Error fetching {url}: {exc}"}]

        content_type = resp.headers.get("content-type", "")
        is_html = "html" in content_type or resp.text.strip().startswith("<!")

        if is_html:
            # Prefer trafilatura for main-content extraction; fall back to regex strip on apps/login walls/JS-heavy pages.
            text: str | None = None
            try:
                import trafilatura  # type: ignore
                text = trafilatura.extract(
                    resp.text,
                    include_comments=False,
                    include_tables=True,
                    favor_precision=True,
                )
            except Exception:
                text = None
            if not text:
                text = _strip_html(resp.text)
        else:
            text = resp.text

        text = _truncate(text)

        header = f"Contents of {url}:"
        if prompt:
            header += f"\n(Looking for: {prompt})"

        return [{"type": "text", "text": f"{header}\n\n{text}"}]
