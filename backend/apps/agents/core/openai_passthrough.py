"""Tiny OpenAI passthrough renaming max_tokens to max_completion_tokens for GPT-5; 9Router 0.3.60 is pinned and doesn't know the change."""

import json
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)


@asynccontextmanager
async def openai_passthrough_lifespan():
    yield


openai_passthrough = SubApp("openai-passthrough", openai_passthrough_lifespan)


# Mirrors anthropic_proxy.py's GPT-5 matcher; duplicated to avoid the cross-module dep.
P_GPT5_PREFIXES = ("gpt-5",)
P_OPENAI_UPSTREAM = "https://api.openai.com/v1"
P_HOP_HEADERS = {
    "host", "content-length", "connection", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "transfer-encoding", "upgrade",
}


def p_is_gpt5(model: str) -> bool:
    m = (model or "").strip().lower()
    if not m:
        return False
    for prefix in ("openai/", "cx/", "openrouter/", "or:openai/", "cp/", "cp-"):
        if m.startswith(prefix):
            m = m[len(prefix):]
            break
    return any(m.startswith(p) for p in P_GPT5_PREFIXES)


# GPT-5 reasoning models reject sampling knobs: temperature must be the default (only 1 is allowed), and top_p / penalties / logprobs are unsupported outright. 9Router 0.3.60 is pinned and forwards whatever the user's picked model carried, so we strip them at this last hop before OpenAI or the whole request 400s.
P_GPT5_UNSUPPORTED_PARAMS = (
    "top_p", "top_k", "frequency_penalty", "presence_penalty",
    "logprobs", "top_logprobs", "logit_bias",
)

# Our OpenAI lane's 9Router node prefix; 0.3.60 intermittently forwards the model WITH it (cp-openai/gpt-5.5) so OpenAI 400s "invalid model ID", and as the last hop we strip it to the bare id.
P_CP_OPENAI_PREFIX = "cp-openai/"

# GPT-5 burns 8-30K hidden reasoning tokens before output and OpenAI 400s "max_tokens reached" under that; the 9router_gpt5 patch's floor never fires on our lane (9Router calls this passthrough, not api.openai.com), so floor it here, only raising.
P_GPT5_MIN_COMPLETION_TOKENS = 32768


def scrub_gpt5_params(body: bytes) -> bytes:
    """Prep an OpenAI chat body: normalize the model id (drop a leaked `cp-openai/`
    routing prefix) and, for GPT-5, rename max_tokens→max_completion_tokens and drop the
    sampling params the reasoning models reject. Bytes in/out, never raises."""
    if not body:
        return body
    try:
        parsed = json.loads(body)
    except Exception:
        return body
    if not isinstance(parsed, dict):
        return body
    mutated = False
    model = str(parsed.get("model") or "")
    if model.startswith(P_CP_OPENAI_PREFIX):
        model = model[len(P_CP_OPENAI_PREFIX):]
        parsed["model"] = model
        mutated = True
    if not p_is_gpt5(model):
        return json.dumps(parsed).encode("utf-8") if mutated else body
    if "max_tokens" in parsed:
        if "max_completion_tokens" not in parsed:
            parsed["max_completion_tokens"] = parsed.pop("max_tokens")
        else:
            parsed.pop("max_tokens", None)
        mutated = True
    mct = parsed.get("max_completion_tokens")
    if isinstance(mct, (int, float)) and not isinstance(mct, bool) and mct < P_GPT5_MIN_COMPLETION_TOKENS:
        parsed["max_completion_tokens"] = P_GPT5_MIN_COMPLETION_TOKENS
        mutated = True
    if "temperature" in parsed and parsed["temperature"] != 1:
        parsed.pop("temperature", None)
        mutated = True
    for k in P_GPT5_UNSUPPORTED_PARAMS:
        if parsed.pop(k, None) is not None:
            mutated = True
    # OpenAI started rejecting reasoning_effort + function tools together on /chat/completions (live-confirmed 2026-07-08, all gpt-5.x); dropping effort loses thinking but the turn completes. Real fix = /v1/responses migration.
    if "tools" in parsed and parsed.pop("reasoning_effort", None) is not None:
        mutated = True
    return json.dumps(parsed).encode("utf-8") if mutated else body


@openai_passthrough.router.api_route(
    "/v1/{rest:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
)
async def passthrough(rest: str, request: Request):
    body = await request.body()
    body = scrub_gpt5_params(body)

    forward_headers: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() in P_HOP_HEADERS:
            continue
        forward_headers[k] = v

    upstream_url = f"{P_OPENAI_UPSTREAM}/{rest}"
    if request.url.query:
        upstream_url = f"{upstream_url}?{request.url.query}"

    # Stream upstream body back; httpx handles SSE without buffering the full response.
    client = httpx.AsyncClient(timeout=httpx.Timeout(connect=10.0, read=300.0, write=60.0, pool=30.0))
    try:
        upstream_req = client.build_request(
            request.method,
            upstream_url,
            headers=forward_headers,
            content=body,
        )
        upstream_resp = await client.send(upstream_req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        logger.warning("openai-passthrough upstream error: %s", e)
        return JSONResponse(
            {"error": {"message": str(e), "type": "upstream_error"}},
            status_code=502,
        )

    # OpenAI sends 4xx/5xx as a small JSON error (not a stream); surface its real complaint (we used to swallow it) and return it decoded so the caller sees why.
    if upstream_resp.status_code >= 400:
        raw = await upstream_resp.aread()
        await upstream_resp.aclose()
        await client.aclose()
        logger.warning(
            "openai-passthrough upstream %s on /%s: %s",
            upstream_resp.status_code, rest, raw.decode("utf-8", "replace")[:400],
        )
        return Response(
            content=raw,
            status_code=upstream_resp.status_code,
            media_type=upstream_resp.headers.get("content-type", "application/json"),
        )

    response_headers: dict[str, str] = {}
    for k, v in upstream_resp.headers.items():
        if k.lower() in P_HOP_HEADERS:
            continue
        response_headers[k] = v

    async def streamer():
        try:
            async for chunk in upstream_resp.aiter_raw():
                yield chunk
        finally:
            await upstream_resp.aclose()
            await client.aclose()

    return StreamingResponse(
        streamer(),
        status_code=upstream_resp.status_code,
        headers=response_headers,
    )
