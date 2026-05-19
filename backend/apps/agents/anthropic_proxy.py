"""Lightweight Anthropic-format HTTP proxy.

When a user is on openswarm-pro with a non-Claude primary (GPT/Gemini/etc.),
the Claude Code CLI needs a single `ANTHROPIC_BASE_URL` that can serve BOTH:

    1. the primary model calls (e.g. `cx/gpt-5` → must go to 9Router)
    2. auxiliary Claude calls for subagents, WebSearch delegation
       (e.g. `claude-haiku-4-5` → must go to OpenSwarm Pro's cloud proxy)

9Router doesn't know about OpenSwarm Pro, and we don't want to maintain a
custom 9Router provider-node for that. This proxy splits requests by the
`model` field in the body and forwards each to the correct upstream.

Mounted at `/api/anthropic-proxy`. Set `ANTHROPIC_BASE_URL` to
`http://127.0.0.1:<backend-port>/api/anthropic-proxy` in the CLI env for
Pro users with non-Claude primaries.
"""

import json
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)


@asynccontextmanager
async def anthropic_proxy_lifespan():
    yield


anthropic_proxy = SubApp("anthropic-proxy", anthropic_proxy_lifespan)


_CLAUDE_MODEL_PREFIXES = (
    "claude-",
    "claude/",
    "sonnet",
    "opus",
    "haiku",
    "cc/",
)

_GEMINI_MODEL_PREFIXES = ("gemini/", "gc/", "ag/")

_OPENAI_MODEL_PREFIXES = ("gpt-", "cx/", "openai/", "o1", "o3", "o4")


def _fix_openai_max_tokens(body: bytes) -> bytes:
    """Rename max_tokens → max_completion_tokens for OpenAI models that require it."""
    if not body:
        return body
    try:
        parsed = json.loads(body)
    except Exception:
        return body
    if isinstance(parsed, dict) and "max_tokens" in parsed and "max_completion_tokens" not in parsed:
        parsed["max_completion_tokens"] = parsed.pop("max_tokens")
        return json.dumps(parsed).encode("utf-8")
    return body

# Fields Gemini's function_declarations validator rejects. 9Router 0.3.60's
# translator strips allOf/anyOf/oneOf/const-toplevel/required but misses these.
_GEMINI_FORBIDDEN_SCHEMA_KEYS = {
    "$schema",
    "additionalProperties",
    "propertyNames",
    "patternProperties",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "const",  # nested const leaks through 9Router's top-level-only strip.
}


def _scrub_gemini_schema(node):
    """Recursive in-place strip of Gemini-rejected JSON Schema fields."""
    if isinstance(node, dict):
        for k in list(node.keys()):
            if k in _GEMINI_FORBIDDEN_SCHEMA_KEYS:
                node.pop(k, None)
                continue
            node[k] = _scrub_gemini_schema(node[k])
        return node
    if isinstance(node, list):
        for i, v in enumerate(node):
            node[i] = _scrub_gemini_schema(v)
        return node
    return node


def _scrub_request_for_gemini(body: bytes) -> bytes:
    """Strip Gemini-incompatible schema keys from request tools. Bytes-in/out, never raises."""
    if not body:
        return body
    try:
        parsed = json.loads(body)
    except Exception:
        return body
    tools = parsed.get("tools") if isinstance(parsed, dict) else None
    if isinstance(tools, list):
        for t in tools:
            if not isinstance(t, dict):
                continue
            if isinstance(t.get("input_schema"), (dict, list)):
                _scrub_gemini_schema(t["input_schema"])
            if isinstance(t.get("parameters"), (dict, list)):
                _scrub_gemini_schema(t["parameters"])
    return json.dumps(parsed).encode("utf-8")


# Headers we strip before forwarding — these change hop-by-hop or we
# replace them with upstream-specific auth.
_HOP_HEADERS = {
    "host",
    "content-length",
    "authorization",
    "x-api-key",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


def _is_claude_model(model: str) -> bool:
    m = (model or "").strip().lower()
    return m.startswith(_CLAUDE_MODEL_PREFIXES)


def _is_gemini_model(model: str) -> bool:
    m = (model or "").strip().lower()
    return m.startswith(_GEMINI_MODEL_PREFIXES)


def _is_openai_model(model: str) -> bool:
    m = (model or "").strip().lower()
    return m.startswith(_OPENAI_MODEL_PREFIXES)


def _pick_upstream(model: str) -> tuple[str, dict[str, str]]:
    """Return (base_url_without_v1, auth_headers) for this model."""
    from backend.apps.settings.settings import load_settings
    s = load_settings()

    if _is_claude_model(model):
        # Prefer Pro cloud proxy when configured.
        if getattr(s, "connection_mode", "own_key") == "openswarm-pro":
            bearer = getattr(s, "openswarm_bearer_token", "") or ""
            proxy = (getattr(s, "openswarm_proxy_url", "") or "https://api.openswarm.com").rstrip("/")
            if bearer and proxy:
                return (proxy, {"Authorization": f"Bearer {bearer}"})
        # Fall through — let 9Router handle it (maybe user has a real Claude sub).

    # Default: 9Router for everything else (cx/, gc/, gh/, apikey-routed models).
    return ("http://127.0.0.1:20128", {"x-api-key": "9router"})


@anthropic_proxy.router.api_route(
    "",
    methods=["GET", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
@anthropic_proxy.router.api_route(
    "/",
    methods=["GET", "HEAD", "OPTIONS"],
    include_in_schema=False,
)
async def _healthcheck():
    """CLI healthchecks the proxy root — return 200 so it doesn't 404."""
    return {"ok": True}


@anthropic_proxy.router.api_route(
    "/v1/{rest:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
)
async def proxy(rest: str, request: Request):
    body = await request.body()
    model = ""
    if body:
        try:
            parsed = json.loads(body)
            model = str(parsed.get("model") or "")
        except Exception:
            pass

    if _is_gemini_model(model):
        body = _scrub_request_for_gemini(body)

    if _is_openai_model(model):
        body = _fix_openai_max_tokens(body)

    base_url, auth_headers = _pick_upstream(model)

    forward_headers: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() in _HOP_HEADERS:
            continue
        # The CLI we spawn carries our per-install auth token via
        # `x-api-key` (we set `ANTHROPIC_API_KEY=<our_token>` on the
        # spawn env, and the CLI forwards that value as x-api-key). We
        # must NOT forward that header to the real upstream — it would
        # leak our local token to api.openswarm.com / 9Router, AND it
        # would shadow the real upstream auth (bearer or `9router`
        # literal) that `_pick_upstream` wants to set. Strip it here.
        if k.lower() == "x-api-key":
            continue
        forward_headers[k] = v
    forward_headers.update(auth_headers)

    url = f"{base_url}/v1/{rest}"
    wants_stream = False
    if body:
        try:
            wants_stream = bool(json.loads(body).get("stream"))
        except Exception:
            pass

    try:
        if wants_stream:
            client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0))
            req = client.build_request(
                request.method, url, content=body, headers=forward_headers,
                params=dict(request.query_params),
            )
            upstream = await client.send(req, stream=True)

            async def streamer():
                try:
                    async for chunk in upstream.aiter_raw():
                        if chunk:
                            yield chunk
                finally:
                    await upstream.aclose()
                    await client.aclose()

            return StreamingResponse(
                streamer(),
                status_code=upstream.status_code,
                headers={k: v for k, v in upstream.headers.items()
                         if k.lower() not in _HOP_HEADERS},
                media_type=upstream.headers.get("content-type", "text/event-stream"),
            )
        else:
            async with httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0)) as client:
                r = await client.request(
                    request.method, url, content=body, headers=forward_headers,
                    params=dict(request.query_params),
                )
                return JSONResponse(
                    content=r.json() if r.headers.get("content-type", "").startswith("application/json") else {"raw": r.text},
                    status_code=r.status_code,
                    headers={k: v for k, v in r.headers.items() if k.lower() not in _HOP_HEADERS},
                )
    except httpx.TimeoutException:
        return JSONResponse({"error": "upstream timeout"}, status_code=504)
    except Exception as e:
        logger.warning(f"anthropic-proxy error: {e}")
        return JSONResponse({"error": str(e)[:300]}, status_code=502)
