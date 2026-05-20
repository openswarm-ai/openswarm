"""Anthropic-format HTTP proxy splitting requests by model field; primary to 9Router, aux Claude to Pro proxy."""

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

# Own-key Gemini ("gemini-3-flash-api" etc.) skips the gemini/ prefix; match bare names so $schema scrub still fires.
_GEMINI_BARE_MODEL_PATTERNS = ("gemini-",)

# Keys 9Router 0.3.60 misses that Gemini's function_declarations validator 400s on. Each was caught in prod.
_GEMINI_FORBIDDEN_SCHEMA_KEYS = {
    "$schema",
    "$id",
    "$ref",
    "$defs",
    "definitions",
    "additionalProperties",
    "propertyNames",
    "patternProperties",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "const",
    "prefill",
    "enumTitles",
    "title",
    "examples",
    "default",
    "readOnly",
    "writeOnly",
    "deprecated",
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


# GPT-5.x rejects max_tokens; needs max_completion_tokens. Anthropic-format wire still emits max_tokens; we rename on the way out.
_OPENAI_MAX_COMPLETION_TOKENS_MODELS = ("gpt-5",)


def _is_openai_max_completion_tokens_model(model: str) -> bool:
    """Match every shape a GPT-5 name might arrive in (bare, api-suffixed, openai/-prefixed, cx/-routed)."""
    m = (model or "").strip().lower()
    if not m:
        return False
    for prefix in ("openai/", "cx/", "openrouter/", "or:openai/", "cp/", "cp-"):
        if m.startswith(prefix):
            m = m[len(prefix):]
            break
    return any(m.startswith(p) for p in _OPENAI_MAX_COMPLETION_TOKENS_MODELS)


def _scrub_request_for_openai_gpt5(body: bytes) -> bytes:
    """Rename max_tokens to max_completion_tokens for GPT-5; bytes in/out, never raises."""
    if not body:
        return body
    try:
        parsed = json.loads(body)
    except Exception:
        return body
    if not isinstance(parsed, dict):
        return body
    if "max_tokens" in parsed and "max_completion_tokens" not in parsed:
        parsed["max_completion_tokens"] = parsed.pop("max_tokens")
        return json.dumps(parsed).encode("utf-8")
    if "max_tokens" in parsed and "max_completion_tokens" in parsed:
        parsed.pop("max_tokens", None)
        return json.dumps(parsed).encode("utf-8")
    return body


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


# Hop-by-hop headers or auth we replace with the upstream-specific value.
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
    if m.startswith(_GEMINI_MODEL_PREFIXES):
        return True
    # Bare-name match for own-key Gemini; excludes anthropic-routed gemini (those carry "/").
    if "/" in m:
        return False
    return any(m.startswith(p) for p in _GEMINI_BARE_MODEL_PATTERNS)


def _pick_upstream(model: str) -> tuple[str, dict[str, str]]:
    """Return (base_url_without_v1, auth_headers) for this model."""
    from backend.apps.settings.settings import load_settings
    s = load_settings()

    if _is_claude_model(model):
        if getattr(s, "connection_mode", "own_key") == "openswarm-pro":
            bearer = getattr(s, "openswarm_bearer_token", "") or ""
            proxy = (getattr(s, "openswarm_proxy_url", "") or "https://api.openswarm.com").rstrip("/")
            if bearer and proxy:
                return (proxy, {"Authorization": f"Bearer {bearer}"})

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
    """CLI healthchecks the proxy root; return 200 so it doesn't 404."""
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
    if _is_openai_max_completion_tokens_model(model):
        body = _scrub_request_for_openai_gpt5(body)

    base_url, auth_headers = _pick_upstream(model)

    forward_headers: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() in _HOP_HEADERS:
            continue
        # CLI carries our install token as x-api-key; never forward (leak + shadows real upstream auth).
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
