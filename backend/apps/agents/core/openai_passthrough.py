"""Tiny OpenAI passthrough renaming max_tokens to max_completion_tokens for GPT-5; 9Router 0.3.60 is pinned and doesn't know the change."""

import json
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)


@asynccontextmanager
async def openai_passthrough_lifespan():
    yield


openai_passthrough = SubApp("openai-passthrough", openai_passthrough_lifespan)


# Mirrors anthropic_proxy.py's GPT-5 matcher; duplicated to avoid the cross-module dep.
_GPT5_PREFIXES = ("gpt-5",)
_OPENAI_UPSTREAM = "https://api.openai.com/v1"
_HOP_HEADERS = {
    "host", "content-length", "connection", "keep-alive",
    "proxy-authenticate", "proxy-authorization", "te", "trailers",
    "transfer-encoding", "upgrade",
}


def _is_gpt5(model: str) -> bool:
    m = (model or "").strip().lower()
    if not m:
        return False
    for prefix in ("openai/", "cx/", "openrouter/", "or:openai/", "cp/", "cp-"):
        if m.startswith(prefix):
            m = m[len(prefix):]
            break
    return any(m.startswith(p) for p in _GPT5_PREFIXES)


def _scrub_max_tokens(body: bytes) -> bytes:
    """Rename max_tokens to max_completion_tokens for GPT-5; bytes in/out, never raises."""
    if not body:
        return body
    try:
        parsed = json.loads(body)
    except Exception:
        return body
    if not isinstance(parsed, dict):
        return body
    model = str(parsed.get("model") or "")
    if not _is_gpt5(model):
        return body
    if "max_tokens" in parsed and "max_completion_tokens" not in parsed:
        parsed["max_completion_tokens"] = parsed.pop("max_tokens")
        return json.dumps(parsed).encode("utf-8")
    if "max_tokens" in parsed and "max_completion_tokens" in parsed:
        parsed.pop("max_tokens", None)
        return json.dumps(parsed).encode("utf-8")
    return body


@openai_passthrough.router.api_route(
    "/v1/{rest:path}",
    methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
)
async def passthrough(rest: str, request: Request):
    body = await request.body()
    body = _scrub_max_tokens(body)

    forward_headers: dict[str, str] = {}
    for k, v in request.headers.items():
        if k.lower() in _HOP_HEADERS:
            continue
        forward_headers[k] = v

    upstream_url = f"{_OPENAI_UPSTREAM}/{rest}"
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

    response_headers: dict[str, str] = {}
    for k, v in upstream_resp.headers.items():
        if k.lower() in _HOP_HEADERS:
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
