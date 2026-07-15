"""Web tools: WebSearch and WebFetch."""

from __future__ import annotations

import re
from typing import Any, Optional

import httpx
from typeguard import typechecked

from backend.apps.agents.tools.base import BaseTool, ToolContext
from backend.apps.agents.tools.search_ddg import (
    DDGRateLimited,
    HTTP_TIMEOUT,
    USER_AGENT,
    strip_html,
)
from backend.apps.agents.tools.search_ddg import search_ddg as run_ddg_search
from backend.apps.agents.tools.ssrf_guard import SSRFBlocked, safe_fetch

P_MAX_OUTPUT_BYTES = 250 * 1024  # ~250 KB covers ~95% of articles/wikis/docs.


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


@typechecked
def should_register_web_mcp(
    *,
    model: str,
    router_model_id: object,
    api_type: Optional[str],
    anthropic_api_key: Optional[str],
    connection_mode: str,
) -> bool:
    """True when the agent loop must register the DDG-backed openswarm-web MCP because the
    primary model has NO reliable native Anthropic web-search path. We prefer Anthropic's
    hosted search (return False) whenever it's actually reachable, and cascade through our own
    /api/web/search (Gemini -> OpenAI -> DuckDuckGo) otherwise. The three no-path cases:
    a non-Claude primary, a custom-provider session (ANTHROPIC_BASE_URL points at 9Router with
    no Claude connection), and a subscription-route Claude model on a non-Pro account (the
    built-in WebSearch's aux haiku call 401s). Pro pool is deliberately NOT counted for a
    non-Claude primary: spending it on WebSearch would drain the user's Claude turns."""
    from backend.apps.agents.providers.registry import find_builtin_model as find_builtin_model

    m = router_model_id if isinstance(router_model_id, str) else ""
    primary_is_claude = m.startswith("cc/") or (
        isinstance(router_model_id, str)
        and not router_model_id.startswith(("cc/", "cx/", "gc/", "ag/", "gemini/"))
        and api_type == "anthropic"
    )
    is_custom_session = api_type == "custom"
    web_model_entry = find_builtin_model(model)
    uses_direct_anthropic_api = (
        web_model_entry is not None
        and web_model_entry.get("route") == "api"
        and web_model_entry.get("api") == "anthropic"
        and bool(anthropic_api_key)
    )
    has_anthropic_path = (
        not is_custom_session
        and primary_is_claude
        and anthropic_web_search_is_reliable(
            uses_direct_anthropic_api=uses_direct_anthropic_api,
            is_pro=(connection_mode in ("openswarm-pro", "free-trial")),
        )
    )
    return not has_anthropic_path


def p_truncate(text: str, limit: int = P_MAX_OUTPUT_BYTES) -> str:
    if len(text) > limit:
        return text[:limit] + "\n... (output truncated)"
    return text


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
            results = await self.search_ddg(query, num_results)
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
    async def search_ddg(query: str, num_results: int) -> str:
        return await run_ddg_search(query, num_results)


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
            resp = await safe_fetch(
                url,
                method="GET",
                headers={"User-Agent": USER_AGENT},
                timeout=HTTP_TIMEOUT,
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
                text = strip_html(resp.text)
        else:
            text = resp.text

        text = p_truncate(text)

        header = f"Contents of {url}:"
        if prompt:
            header += f"\n(Looking for: {prompt})"

        return [{"type": "text", "text": f"{header}\n\n{text}"}]
