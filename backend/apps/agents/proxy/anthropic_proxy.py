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


def _rewrite_document_to_openai_file(parsed: dict) -> None:
    """In-place: rewrite Anthropic base64 `image` blocks to OpenAI `image_url` (PDFs go via OpenRouter)."""
    msgs = parsed.get("messages") if isinstance(parsed, dict) else None
    if not isinstance(msgs, list):
        return
    counter = 0
    for m in msgs:
        content = m.get("content") if isinstance(m, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            src = block.get("source") or {}
            if not isinstance(src, dict) or src.get("type") != "base64":
                continue
            data = src.get("data")
            if not isinstance(data, str) or not data:
                continue
            media_type = src.get("media_type") or ""

            # 9router 0.3.60 chunk 318 stringifies ANY non-`text`/`image_url`
            # block. Image blocks → image_url with data: URL.
            # PDFs on OpenAI direct are REFUSED upstream (agent_manager
            # _resolve_attachments has openai NOT in supports_pdf) because
            # OpenAI Chat Completions rejects non-image mime types inside
            # image_url with "Invalid MIME type. Only image types are
            # supported." (verified empirically May 2026). The shipping
            # path for OpenAI PDFs is openrouter/openai/gpt-5 which uses
            # OR's file-parser plugin.
            if btype != "image":
                continue
            mt = media_type or "image/png"
            block.clear()
            block["type"] = "image_url"
            block["image_url"] = {
                "url": f"data:{mt};base64,{data}",
            }


def _scrub_request_for_openai_gpt5(body: bytes) -> bytes:
    """Rename max_tokens→max_completion_tokens for GPT-5 AND rewrite any
    Anthropic document blocks to OpenAI type:file shape so PDFs flow
    natively on GPT-5.x vision models. Bytes in/out; never raises."""
    if not body:
        return body
    try:
        parsed = json.loads(body)
    except Exception:
        return body
    if not isinstance(parsed, dict):
        return body
    mutated = False
    if "max_tokens" in parsed and "max_completion_tokens" not in parsed:
        parsed["max_completion_tokens"] = parsed.pop("max_tokens")
        mutated = True
    elif "max_tokens" in parsed and "max_completion_tokens" in parsed:
        parsed.pop("max_tokens", None)
        mutated = True
    try:
        before = json.dumps(parsed.get("messages"), sort_keys=True) if "messages" in parsed else ""
        _rewrite_document_to_openai_file(parsed)
        after = json.dumps(parsed.get("messages"), sort_keys=True) if "messages" in parsed else ""
        if before != after:
            mutated = True
    except Exception:
        pass
    return json.dumps(parsed).encode("utf-8") if mutated else body


def _rewrite_document_to_image(parsed: dict) -> None:
    """In-place: rewrite Anthropic `document` (PDF) AND `image` content
    blocks → OpenAI `image_url` shape with a `data:` URL. Critical fix
    for 9router 0.3.60 which **only translates `image_url` blocks** to
    Gemini's `inlineData` (verified in router/.next/server/chunks/318.js:
    `b.image_url?.url?.startsWith('data:')` → builds `{inlineData:{mime_type,data}}`).

    Anthropic-shape `image`/`document` blocks fall through 9router's
    content filter and either get stringified or dropped, which is why
    PDFs were silently missing from Gemini requests until this rewrite.

    For PDFs we set mime_type=application/pdf in the data URL; Gemini's
    inlineData accepts it natively.

    Strictly defensive: rewrite only when source.type='base64' and data
    is present. Unknown shapes pass through untouched."""
    msgs = parsed.get("messages") if isinstance(parsed, dict) else None
    if not isinstance(msgs, list):
        return
    for m in msgs:
        content = m.get("content") if isinstance(m, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype not in ("document", "image"):
                continue
            src = block.get("source") or {}
            if not isinstance(src, dict) or src.get("type") != "base64":
                continue
            data = src.get("data")
            if not isinstance(data, str) or not data:
                continue
            if btype == "document":
                media_type = src.get("media_type") or "application/pdf"
            else:
                media_type = src.get("media_type") or "image/png"
            block.clear()
            block["type"] = "image_url"
            block["image_url"] = {
                "url": f"data:{media_type};base64,{data}",
            }


_OPENROUTER_MODEL_PREFIXES = ("openrouter/", "or:")


def _is_openrouter_model(model: str) -> bool:
    m = (model or "").strip().lower()
    return any(m.startswith(p) for p in _OPENROUTER_MODEL_PREFIXES)


def _inject_openrouter_file_parser(body: bytes) -> bytes:
    """When the request has document blocks AND is bound for OpenRouter,
    inject the file-parser plugin so OR's universal PDF support kicks in
    on any model (free models get pdf-text engine; native PDF models can
    still see the document directly). The plugins field sits at the top
    level alongside `messages`; we don't touch the message content blocks,
    OR's normaliser handles Anthropic→target translation.
    Bytes-in/out, never raises."""
    if not body:
        return body
    try:
        parsed = json.loads(body)
    except Exception:
        return body
    if not isinstance(parsed, dict):
        return body
    msgs = parsed.get("messages")
    if not isinstance(msgs, list):
        return body
    has_doc = False
    for m in msgs:
        content = m.get("content") if isinstance(m, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "document":
                has_doc = True
                break
        if has_doc:
            break
    if not has_doc:
        return body
    existing = parsed.get("plugins")
    plugins = existing if isinstance(existing, list) else []
    if not any(isinstance(p, dict) and p.get("id") == "file-parser" for p in plugins):
        plugins.append({"id": "file-parser", "pdf": {"engine": "pdf-text"}})
    parsed["plugins"] = plugins
    return json.dumps(parsed).encode("utf-8")


def _scrub_request_for_gemini(body: bytes) -> bytes:
    """Strip Gemini-incompatible schema keys from request tools AND
    rewrite Anthropic document blocks to image-shape so 9router's
    inline_data translator picks them up. Bytes-in/out, never raises."""
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
    try:
        if isinstance(parsed, dict):
            _rewrite_document_to_image(parsed)
    except Exception:
        pass
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
    """Return (base_url_without_v1, auth_headers) for this model.

    Routing for Claude-family models:
      1. openswarm-pro mode → cloud proxy with bearer
      2. Direct Anthropic API key set → api.anthropic.com (preferred when
         user has their own key, avoids the 8h OAuth expiry pain)
      3. Fallback → 9router (cc/ OAuth subscription, may 401 if expired)
    Everything non-Claude goes to 9router for translation."""
    from backend.apps.settings.settings import load_settings
    s = load_settings()

    if _is_claude_model(model):
        if getattr(s, "connection_mode", "own_key") == "openswarm-pro":
            bearer = getattr(s, "openswarm_bearer_token", "") or ""
            proxy = (getattr(s, "openswarm_proxy_url", "") or "https://api.openswarm.com").rstrip("/")
            if bearer and proxy:
                return (proxy, {"Authorization": f"Bearer {bearer}"})
        ak = getattr(s, "anthropic_api_key", "") or ""
        if ak.strip():
            return ("https://api.anthropic.com", {
                "x-api-key": ak.strip(),
                "anthropic-version": "2023-06-01",
            })

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

    # 9router-bypass paths for PDF-bearing requests on providers where
    # 9router 0.3.60 strips or mangles the relevant content/plugin
    # fields. We translate + POST directly to the provider's API and
    # convert the streaming response back to Anthropic SSE so the
    # bundled Claude CLI subprocess consumes it unchanged.
    try:
        parsed_for_bypass = json.loads(body) if body else None
    except Exception:
        parsed_for_bypass = None
    if isinstance(parsed_for_bypass, dict):
        from backend.apps.agents.proxy.anthropic_to_openai import (
            should_bypass_9router as _should_bypass_oai,
            should_bypass_9router_for_openrouter as _should_bypass_or,
            forward_to_openai as _forward_oai,
            forward_to_openrouter as _forward_or,
        )
        from backend.apps.settings.settings import load_settings as _load
        _s = _load()
        if _is_openai_max_completion_tokens_model(model):
            _oak = (getattr(_s, "openai_api_key", "") or "").strip()
            if _should_bypass_oai(parsed_for_bypass, _oak):
                status, body_stream, hdrs = await _forward_oai(
                    parsed_for_bypass, _oak,
                )
                return StreamingResponse(
                    body_stream, status_code=status, headers=hdrs,
                    media_type=hdrs.get("content-type", "text/event-stream"),
                )
        if _is_openrouter_model(model):
            _ork = (getattr(_s, "openrouter_api_key", "") or "").strip()
            if _should_bypass_or(parsed_for_bypass, _ork):
                status, body_stream, hdrs = await _forward_or(
                    parsed_for_bypass, _ork,
                )
                return StreamingResponse(
                    body_stream, status_code=status, headers=hdrs,
                    media_type=hdrs.get("content-type", "text/event-stream"),
                )

    if _is_gemini_model(model):
        body = _scrub_request_for_gemini(body)
    if _is_openai_max_completion_tokens_model(model):
        body = _scrub_request_for_openai_gpt5(body)
    if _is_openrouter_model(model):
        body = _inject_openrouter_file_parser(body)

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
