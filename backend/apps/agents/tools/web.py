"""Web tools: WebSearch and WebFetch."""

from __future__ import annotations

import html
import re
from typing import Any

import httpx

from backend.apps.agents.tools.base import BaseTool, ToolContext
from backend.apps.agents.tools.url_guard import BlockedURLError, fetch_guarded

_HTTP_TIMEOUT = 30
_MAX_OUTPUT_BYTES = 250 * 1024  # ~250 KB covers ~95% of articles/wikis/docs.
_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


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

    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        query: str = input_data["query"]
        num_results: int = input_data.get("num_results", 5)

        try:
            results = await self._search_ddg(query, num_results)
            if not results:
                return [{"type": "text", "text": f"No search results found for: {query}"}]
            return [{"type": "text", "text": results}]
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

    async def execute(self, input_data: dict, context: ToolContext) -> list[dict]:
        url: str = input_data["url"]
        prompt: str | None = input_data.get("prompt")

        try:
            # follow_redirects=False so url_guard re-checks every hop; httpx's own
            # auto-redirect would happily 30x-pivot us into the LAN.
            async with httpx.AsyncClient(
                timeout=_HTTP_TIMEOUT,
                follow_redirects=False,
                headers={"User-Agent": _USER_AGENT},
            ) as client:
                resp = await fetch_guarded(client, url)
                resp.raise_for_status()
        except BlockedURLError as exc:
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
