"""Web tools: WebSearch and WebFetch."""

from __future__ import annotations

import html
import re
from typing import Any

import httpx

from backend.apps.agents.tools.base import BaseTool, ToolContext

_MAX_OUTPUT_BYTES = 100 * 1024  # ~100 KB
_HTTP_TIMEOUT = 30  # seconds
_USER_AGENT = (
    "Mozilla/5.0 (compatible; SelfSwarmBot/1.0; +https://github.com/openswarm-ai/self-swarm)"
)


def _truncate(text: str, limit: int = _MAX_OUTPUT_BYTES) -> str:
    if len(text) > limit:
        return text[:limit] + "\n... (output truncated)"
    return text


def _strip_html(raw_html: str) -> str:
    """Naive but effective HTML → plain-text conversion."""
    # Remove script/style blocks
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", raw_html, flags=re.DOTALL | re.IGNORECASE)
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", " ", text)
    # Decode HTML entities
    text = html.unescape(text)
    # Collapse whitespace
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ───────────────────────────────────────────────────────────────────────────
# WebSearchTool
# ───────────────────────────────────────────────────────────────────────────


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

        # Parse result blocks – DuckDuckGo wraps each result in
        # <div class="result ..."> ... </div>
        result_blocks = re.findall(
            r'<div[^>]*class="[^"]*result[^"]*"[^>]*>(.*?)</div>\s*(?=<div[^>]*class="[^"]*result|$)',
            body,
            flags=re.DOTALL,
        )

        entries: list[str] = []
        for block in result_blocks:
            if len(entries) >= num_results:
                break

            # Title + URL — handle both class-before-href and href-before-class
            link_match = re.search(
                r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
                block,
                flags=re.DOTALL,
            )
            if not link_match:
                # Try reversed attribute order
                link_match = re.search(
                    r'<a[^>]*href="([^"]*)"[^>]*class="[^"]*result__a[^"]*"[^>]*>(.*?)</a>',
                    block,
                    flags=re.DOTALL,
                )
            if not link_match:
                continue

            raw_url = html.unescape(link_match.group(1))
            title = _strip_html(link_match.group(2)).strip()

            # Snippet
            snippet_match = re.search(
                r'<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>',
                block,
                flags=re.DOTALL,
            )
            snippet = _strip_html(snippet_match.group(1)).strip() if snippet_match else ""

            # DuckDuckGo wraps URLs through a redirect; try to extract the real URL
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


# ───────────────────────────────────────────────────────────────────────────
# WebFetchTool
# ───────────────────────────────────────────────────────────────────────────


class WebFetchTool(BaseTool):
    name = "WebFetch"
    description = (
        "Fetch the contents of a URL and return the extracted text. "
        "HTML is stripped to plain text. Output is truncated to ~100 KB."
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
            async with httpx.AsyncClient(
                timeout=_HTTP_TIMEOUT,
                follow_redirects=True,
                headers={"User-Agent": _USER_AGENT},
            ) as client:
                resp = await client.get(url)
                resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            return [{"type": "text", "text": f"HTTP error {exc.response.status_code} fetching {url}"}]
        except Exception as exc:
            return [{"type": "text", "text": f"Error fetching {url}: {exc}"}]

        content_type = resp.headers.get("content-type", "")

        if "html" in content_type or resp.text.strip().startswith("<!"):
            text = _strip_html(resp.text)
        else:
            text = resp.text

        text = _truncate(text)

        header = f"Contents of {url}:"
        if prompt:
            header += f"\n(Looking for: {prompt})"

        return [{"type": "text", "text": f"{header}\n\n{text}"}]
