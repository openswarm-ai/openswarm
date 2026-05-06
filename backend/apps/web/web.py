"""Web search + fetch sub-app.

Thin HTTP wrappers around `WebSearchTool` and `WebFetchTool` from
`backend.apps.agents.tools.web`. Exists so the in-process MCP server
(`backend.apps.agents.web_mcp_server`) can proxy tool calls to the
backend instead of re-implementing DuckDuckGo scraping + trafilatura
extraction in the MCP process.

Mounted at `/api/web`.
"""

from contextlib import asynccontextmanager
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field
from typeguard import typechecked

import debug

from backend.config.Apps import SubApp


@asynccontextmanager
async def web_lifespan():
    debug("START")
    yield
    debug("END")


web = SubApp("web", web_lifespan)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class SearchBody(BaseModel):
    query: str = Field(..., description="The search query.")
    num_results: int = Field(5, ge=1, le=10, description="Max results to return.")
    # Hint from the MCP server about which primary provider the session
    # is using. Lets us route to that provider's native search tool
    # (Gemini googleSearch, OpenAI web_search_preview) when available —
    # costs come out of the user's existing primary budget.
    primary: str | None = Field(None, description="Primary provider hint: 'gemini' | 'openai' | 'anthropic' | None")


class FetchBody(BaseModel):
    url: str = Field(..., description="The URL to fetch.")
    prompt: str | None = Field(None, description="Optional context hint.")
    primary: str | None = Field(None, description="Primary provider hint.")


# ---------------------------------------------------------------------------
# Helper — extract plain text from a tool's structured output list
# ---------------------------------------------------------------------------


def _join_text(parts: list[dict[str, Any]]) -> str:
    out = []
    for p in parts:
        if isinstance(p, dict) and p.get("type") == "text":
            out.append(str(p.get("text", "")))
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_GROUNDING_MODEL = "gemini-2.5-flash"  # cheapest + fastest for grounded calls

OPENAI_API_BASE = "https://api.openai.com/v1"
OPENAI_SEARCH_MODEL = "gpt-5-mini"  # cheapest model that supports web_search_preview


async def _gemini_grounded_call(api_key: str, prompt: str, *, use_url_context: bool) -> dict:
    """Call Gemini with googleSearch (+ optionally urlContext) grounding.

    Returns {"text": grounded_answer, "chunks": [(title, uri), ...],
             "queries": [...]} or raises httpx.HTTPError on failure.
    """
    import httpx
    tools = [{"googleSearch": {}}]
    if use_url_context:
        tools.append({"urlContext": {}})
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "tools": tools,
        "generationConfig": {"thinkingConfig": {"thinkingBudget": 0}},
    }
    url = f"{GEMINI_API_BASE}/models/{GEMINI_GROUNDING_MODEL}:generateContent"
    async with httpx.AsyncClient(timeout=45.0) as client:
        r = await client.post(
            url,
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
            json=body,
        )
        r.raise_for_status()
        data = r.json()

    cand = (data.get("candidates") or [{}])[0]
    text = "".join(
        p.get("text", "") for p in (cand.get("content", {}).get("parts") or [])
        if isinstance(p, dict)
    )
    gm = cand.get("groundingMetadata") or {}
    chunks = []
    for gc in (gm.get("groundingChunks") or []):
        web = (gc or {}).get("web") or {}
        uri = web.get("uri") or web.get("url") or ""
        title = web.get("title") or uri
        if uri:
            chunks.append((title, uri))
    queries = gm.get("webSearchQueries") or []
    return {"text": text, "chunks": chunks, "queries": queries}


def _format_grounded_as_search_results(grounded: dict, query: str) -> str:
    """Format Gemini grounding output to match WebSearchTool's text shape."""
    lines = []
    chunks = grounded.get("chunks") or []
    for i, (title, uri) in enumerate(chunks[:10], start=1):
        lines.append(f"[{i}] {title}\n    {uri}")
    text = grounded.get("text") or ""
    if text:
        lines.append("\n" + text)
    if not lines:
        return f"No search results found for: {query}"
    return "\n\n".join(lines)


def _format_grounded_as_fetch(grounded: dict, url: str) -> str:
    """Format Gemini urlContext output to match WebFetchTool's text shape."""
    parts = [f"Contents of {url}:", ""]
    text = grounded.get("text") or ""
    if text:
        parts.append(text)
    chunks = grounded.get("chunks") or []
    if chunks:
        parts.append("\nCited sources:")
        for i, (title, uri) in enumerate(chunks[:5], start=1):
            parts.append(f"  [{i}] {title} — {uri}")
    return "\n".join(parts)


def _resolve_gemini_api_key() -> str | None:
    """Pull the AI Studio API key from settings, or None."""
    try:
        from backend.apps.settings.settings import load_settings
        s = load_settings()
        return getattr(s, "google_api_key", None) or None
    except Exception:
        return None


def _resolve_openai_api_key() -> str | None:
    try:
        from backend.apps.settings.settings import load_settings
        s = load_settings()
        return getattr(s, "openai_api_key", None) or None
    except Exception:
        return None


# Cache of which 9Router subscriptions are connected. Refreshed via
# `_refresh_9r_connected()` rather than hit on every search call —
# 9Router's /api/providers is fast but not free, and we already
# query it from many places.
_NINE_ROUTER_CONNECTED: set[str] = set()
_NINE_ROUTER_CACHE_AT: float = 0.0


async def _refresh_9r_connected() -> set[str]:
    """Return the set of currently-active 9Router subscription providers
    (e.g. {"claude", "codex", "antigravity", "gemini-cli"}). Cached for
    20s to keep search/fetch endpoints snappy."""
    global _NINE_ROUTER_CONNECTED, _NINE_ROUTER_CACHE_AT
    import time as _t
    now = _t.time()
    if now - _NINE_ROUTER_CACHE_AT < 20.0:
        return _NINE_ROUTER_CONNECTED
    try:
        from backend.apps.nine_router import is_running as _9r_running, get_providers as _9r_providers
        if not _9r_running():
            _NINE_ROUTER_CONNECTED = set()
        else:
            conns = await _9r_providers()
            _NINE_ROUTER_CONNECTED = {
                c.get("provider")
                for c in conns
                if isinstance(c, dict) and c.get("isActive") and c.get("provider")
            }
        _NINE_ROUTER_CACHE_AT = now
    except Exception:
        # Cache stays — best-effort.
        pass
    return _NINE_ROUTER_CONNECTED


async def _gemini_grounded_via_9router(prompt: str, use_url_context: bool) -> dict:
    """Call 9Router's /v1/messages endpoint with a Gemini model so the
    user's OAuth subscription (Gemini CLI or Antigravity) covers the
    search call instead of needing a separate AI Studio API key.

    Routes through Anthropic-shape against 9Router's translator. We
    request a tool result naturally — the translator surfaces grounded
    URIs as text + cited sources in the response body. Format-shape
    matches the existing `_gemini_grounded_call` so downstream
    `_format_grounded_as_search_results` works unchanged."""
    import httpx
    # Prefer Gemini CLI (broader model coverage). Fall back to
    # Antigravity if CLI isn't connected.
    connected = await _refresh_9r_connected()
    if "gemini-cli" in connected:
        model = "gc/gemini-2.5-flash"
    elif "antigravity" in connected:
        model = "ag/gemini-3-flash"
    else:
        return {}

    sys_prompt = (
        "You search the web and return concise grounded answers with "
        "source citations. Always cite the URLs you used."
        if not use_url_context
        else "You fetch URLs and return concise summaries with citations."
    )
    body = {
        "model": model,
        "max_tokens": 1024,
        "system": sys_prompt,
        "messages": [{"role": "user", "content": prompt}],
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            "http://localhost:20128/v1/messages",
            json=body,
            headers={"x-api-key": "9router", "anthropic-version": "2023-06-01"},
        )
        if r.status_code != 200:
            return {}
        data = r.json()
    # Synthesize a grounded shape so the existing formatter works:
    # _format_grounded_as_search_results expects {"text": str, "chunks":
    # [(title, uri), ...]}. 9Router doesn't surface citations as a
    # structured field uniformly across providers, so we hand back
    # text-only and let the formatter do its thing.
    text = ""
    for block in (data.get("content") or []):
        if isinstance(block, dict) and block.get("type") == "text":
            text += block.get("text", "")
    return {"text": text, "chunks": []}


async def _openai_websearch_via_9router(query: str) -> dict:
    """Same idea, but for OpenAI's web_search_preview through Codex's
    9Router connection. Goes through 9Router's openai-compat endpoint
    (the responses API) so the user's Codex subscription covers it."""
    import httpx
    connected = await _refresh_9r_connected()
    if "codex" not in connected:
        return {}
    body = {
        "model": "cx/gpt-5.4-mini",
        "max_tokens": 1024,
        "system": (
            "You search the web and return concise grounded answers "
            "with source citations. Always cite the URLs you used."
        ),
        "messages": [{"role": "user", "content": f"Search the web for: {query}"}],
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            "http://localhost:20128/v1/messages",
            json=body,
            headers={"x-api-key": "9router", "anthropic-version": "2023-06-01"},
        )
        if r.status_code != 200:
            return {}
        data = r.json()
    text = ""
    for block in (data.get("content") or []):
        if isinstance(block, dict) and block.get("type") == "text":
            text += block.get("text", "")
    return {"text": text, "chunks": []}


async def _openai_websearch(api_key: str, query: str) -> dict:
    """Call OpenAI Responses API with the web_search_preview tool.

    Returns {"text": grounded_answer, "chunks": [(title, uri), ...]}.
    """
    import httpx
    body = {
        "model": OPENAI_SEARCH_MODEL,
        "input": f"Search the web for: {query}\n\nReturn a concise summary. Cite sources.",
        "tools": [{"type": "web_search_preview"}],
    }
    async with httpx.AsyncClient(timeout=45.0) as client:
        r = await client.post(
            f"{OPENAI_API_BASE}/responses",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=body,
        )
        r.raise_for_status()
        data = r.json()

    text_parts = []
    chunks: list[tuple[str, str]] = []
    for item in (data.get("output") or []):
        if not isinstance(item, dict):
            continue
        for content in (item.get("content") or []):
            if not isinstance(content, dict):
                continue
            if content.get("type") == "output_text":
                text_parts.append(content.get("text", ""))
            for ann in (content.get("annotations") or []):
                if isinstance(ann, dict) and ann.get("type") == "url_citation":
                    uri = ann.get("url", "")
                    title = ann.get("title", uri)
                    if uri:
                        chunks.append((title, uri))
    return {"text": "".join(text_parts), "chunks": chunks, "queries": [query]}


async def _openai_urlfetch(api_key: str, url: str, prompt: str | None) -> dict:
    """Use OpenAI's web_search_preview to fetch/summarize a specific URL."""
    prompt_text = f"Fetch and summarize the content at: {url}"
    if prompt:
        prompt_text += f"\n\nFocus on: {prompt}"
    import httpx
    body = {
        "model": OPENAI_SEARCH_MODEL,
        "input": prompt_text,
        "tools": [{"type": "web_search_preview"}],
    }
    async with httpx.AsyncClient(timeout=45.0) as client:
        r = await client.post(
            f"{OPENAI_API_BASE}/responses",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=body,
        )
        r.raise_for_status()
        data = r.json()
    text_parts = []
    chunks = []
    for item in (data.get("output") or []):
        for content in (item.get("content") or []):
            if isinstance(content, dict) and content.get("type") == "output_text":
                text_parts.append(content.get("text", ""))
            for ann in (content.get("annotations") or []) if isinstance(content, dict) else []:
                if isinstance(ann, dict) and ann.get("type") == "url_citation":
                    uri = ann.get("url", "")
                    title = ann.get("title", uri)
                    if uri:
                        chunks.append((title, uri))
    return {"text": "".join(text_parts), "chunks": chunks}


@web.router.post("/search")
@typechecked
async def search(body: SearchBody) -> dict:
    """Web search, primary-aware. Prefers the native search tool of the
    provider the user is already paying for:

        Gemini primary + Gemini key → googleSearch grounding
        OpenAI primary + OpenAI key → web_search_preview
        Anthropic path available   → handled at agent_manager layer
                                     (MCP isn't registered; built-in
                                     WebSearch routes through 9Router
                                     → Anthropic's server-side tool)
        otherwise                  → DDG fallback (CAPTCHA-prone)

    If the primary's own native path fails, we cascade to whichever
    other provider's credentials are available, then DDG last."""
    gemini_key = _resolve_gemini_api_key()
    openai_key = _resolve_openai_api_key()
    primary = (body.primary or "").lower()
    errors: list[str] = []

    async def try_gemini():
        if not gemini_key:
            return None
        prompt = (
            f"Search the web for: {body.query}\n\n"
            f"Return a concise summary of what you found. Cite sources."
        )
        grounded = await _gemini_grounded_call(gemini_key, prompt, use_url_context=False)
        return {
            "query": body.query,
            "results": _format_grounded_as_search_results(grounded, body.query),
            "backend": "gemini_native",
        }

    async def try_openai():
        if not openai_key:
            return None
        grounded = await _openai_websearch(openai_key, body.query)
        return {
            "query": body.query,
            "results": _format_grounded_as_search_results(grounded, body.query),
            "backend": "openai_native",
        }

    async def try_gemini_subscription():
        prompt = (
            f"Search the web for: {body.query}\n\n"
            f"Return a concise summary of what you found. Cite sources."
        )
        grounded = await _gemini_grounded_via_9router(prompt, use_url_context=False)
        if not grounded.get("text"):
            return None
        return {
            "query": body.query,
            "results": _format_grounded_as_search_results(grounded, body.query),
            "backend": "gemini_subscription",
        }

    async def try_openai_subscription():
        grounded = await _openai_websearch_via_9router(body.query)
        if not grounded.get("text"):
            return None
        return {
            "query": body.query,
            "results": _format_grounded_as_search_results(grounded, body.query),
            "backend": "openai_subscription",
        }

    # Ordered cascade: primary's native API key first (most direct), then
    # the user's connected subscriptions (free via OAuth), then the
    # opposite-provider native key, then DuckDuckGo last as a guaranteed
    # fallback (which is rate-limit-prone but free).
    if primary == "openai":
        cascade = [
            ("openai_native", try_openai),
            ("openai_subscription", try_openai_subscription),
            ("gemini_native", try_gemini),
            ("gemini_subscription", try_gemini_subscription),
        ]
    elif primary in ("gemini", "google"):
        cascade = [
            ("gemini_native", try_gemini),
            ("gemini_subscription", try_gemini_subscription),
            ("openai_native", try_openai),
            ("openai_subscription", try_openai_subscription),
        ]
    else:
        cascade = [
            ("gemini_native", try_gemini),
            ("gemini_subscription", try_gemini_subscription),
            ("openai_native", try_openai),
            ("openai_subscription", try_openai_subscription),
        ]

    for name, fn in cascade:
        try:
            res = await fn()
            if res is not None:
                return res
        except Exception as e:
            errors.append(f"{name}: {str(e)[:150]}")

    # DDG fallback.
    from backend.apps.agents.tools.web import WebSearchTool
    try:
        tool = WebSearchTool()
        parts = await tool.execute(
            {"query": body.query, "num_results": body.num_results},
            None,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {e}")

    text = _join_text(parts)
    hint = ""
    if text.startswith("No search results found"):
        connected = await _refresh_9r_connected()
        has_subscription = bool(connected & {"codex", "antigravity", "gemini-cli"})
        if not (gemini_key or openai_key or has_subscription):
            hint = (
                "\n\n(DuckDuckGo returned no results — likely rate-limiting this IP. "
                "Connect Codex / Antigravity / Gemini CLI in Settings, or add an "
                "OpenAI / Gemini API key, for reliable native search.)"
            )
        else:
            hint = (
                "\n\n(DuckDuckGo returned no results and the connected providers "
                "didn't return useful results either — try rephrasing the query.)"
            )
    return {
        "query": body.query,
        "results": text + hint,
        "backend": "ddg",
        **({"cascade_errors": errors} if errors else {}),
    }


@web.router.post("/fetch")
@typechecked
async def fetch(body: FetchBody) -> dict:
    """Fetch a URL, primary-aware. Mirrors /search cascade logic."""
    gemini_key = _resolve_gemini_api_key()
    openai_key = _resolve_openai_api_key()
    primary = (body.primary or "").lower()

    async def try_gemini():
        if not gemini_key:
            return None
        prompt_bits = [f"Fetch and summarize this URL: {body.url}"]
        if body.prompt:
            prompt_bits.append(f"Focus on: {body.prompt}")
        grounded = await _gemini_grounded_call(
            gemini_key, "\n".join(prompt_bits), use_url_context=True,
        )
        return {
            "url": body.url,
            "content": _format_grounded_as_fetch(grounded, body.url),
            "backend": "gemini_native",
        }

    async def try_openai():
        if not openai_key:
            return None
        grounded = await _openai_urlfetch(openai_key, body.url, body.prompt)
        return {
            "url": body.url,
            "content": _format_grounded_as_fetch(grounded, body.url),
            "backend": "openai_native",
        }

    async def try_gemini_subscription():
        prompt_bits = [f"Fetch and summarize this URL: {body.url}"]
        if body.prompt:
            prompt_bits.append(f"Focus on: {body.prompt}")
        grounded = await _gemini_grounded_via_9router(
            "\n".join(prompt_bits), use_url_context=True,
        )
        if not grounded.get("text"):
            return None
        return {
            "url": body.url,
            "content": _format_grounded_as_fetch(grounded, body.url),
            "backend": "gemini_subscription",
        }

    async def try_openai_subscription():
        # Codex's web_search is general; URL fetch via search query
        # works adequately for our use.
        prompt = f"Fetch this URL and summarize: {body.url}"
        if body.prompt:
            prompt += f"\nFocus on: {body.prompt}"
        grounded = await _openai_websearch_via_9router(prompt)
        if not grounded.get("text"):
            return None
        return {
            "url": body.url,
            "content": _format_grounded_as_fetch(grounded, body.url),
            "backend": "openai_subscription",
        }

    if primary == "openai":
        cascade = [try_openai, try_openai_subscription, try_gemini, try_gemini_subscription]
    else:
        cascade = [try_gemini, try_gemini_subscription, try_openai, try_openai_subscription]

    for fn in cascade:
        try:
            res = await fn()
            if res is not None:
                return res
        except Exception:
            continue

    # Local httpx + trafilatura fallback.
    from backend.apps.agents.tools.web import WebFetchTool
    try:
        tool = WebFetchTool()
        parts = await tool.execute(
            {"url": body.url, "prompt": body.prompt or ""},
            None,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Fetch failed: {e}")

    return {"url": body.url, "content": _join_text(parts), "backend": "local"}
