"""Anthropic Messages API ↔ OpenAI Chat Completions translator.

Used to bypass 9router 0.3.60 for OpenAI requests that include document
blocks (PDFs). 9router's content-block filter strips any block that
isn't `text` or `image_url`, so PDFs sent as OpenAI's native `type:file`
shape never reach the model. This translator POSTs directly to
api.openai.com using the user's OpenAI API key and converts the
streaming response back to Anthropic Messages SSE format so the
bundled Claude CLI subprocess can consume it unchanged.

Scope: PDFs + images + text. Tool-use translation is NOT covered (the
PDF-attach flow does not need tools in the same turn). If a request has
both tools and documents, fall back to the 9router path which handles
tool-use but strips PDFs (refused upstream in agent_manager).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import AsyncIterator

import httpx

logger = logging.getLogger(__name__)

_OPENAI_UPSTREAM = "https://api.openai.com/v1"
_OPENROUTER_UPSTREAM = "https://openrouter.ai/api/v1"

# Concurrency cap for bypass-route requests. Each in-flight request holds
# the base64'd PDF (raw_bytes * 1.33) in memory across httpx's request
# pipeline + our SSE translator's chunk buffer + the response body. A
# 30MB PDF is ~40MB base64; four in-flight = ~160MB of httpx buffers
# plus Python overhead, which OOM-killed the dev backend on macOS during
# concurrent probes. Cap at 2 so a Mehmet-style multi-PDF attach in one
# session can't take the whole backend down. Requests above the cap
# queue rather than fail.
_BYPASS_CONCURRENCY = 2
_bypass_sema = asyncio.Semaphore(_BYPASS_CONCURRENCY)

# Hard per-request body size ceiling. Anthropic API caps at 32MB,
# OpenAI Chat Completions at 50MB, OpenRouter at whatever underlying
# model accepts. We refuse anything over 40MB raw (≈53MB base64) before
# we even build the request body, so a malicious or accidental huge
# attach never reaches the in-memory pipeline.
_BYPASS_MAX_RAW_BYTES = 40 * 1024 * 1024


def _has_document_block(parsed: dict) -> bool:
    msgs = parsed.get("messages")
    if not isinstance(msgs, list):
        return False
    for m in msgs:
        content = m.get("content") if isinstance(m, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "document":
                return True
    return False


def should_bypass_9router(parsed: dict, api_key: str | None) -> bool:
    """True iff request is a GPT-5.x Chat Completions with at least one
    document block AND user has an OpenAI API key. Anything else falls
    through the normal 9router path."""
    if not api_key:
        return False
    model = (parsed.get("model") or "").lower()
    if not any(model.startswith(p) for p in ("gpt-5", "openai/gpt-5", "cp-openai/gpt-5")):
        return False
    if "codex" in model:
        return False
    if parsed.get("tools"):
        return False
    return _has_document_block(parsed)


def should_bypass_9router_for_openrouter(parsed: dict, api_key: str | None) -> bool:
    """True iff request is bound for OpenRouter AND has document blocks
    AND user has an OpenRouter API key. 9router 0.3.60 doesn't know
    about OR's `plugins` field and silently strips it; we bypass to
    inject the file-parser plugin and POST directly to openrouter.ai."""
    if not api_key:
        return False
    model = (parsed.get("model") or "").lower()
    if not (model.startswith("openrouter/") or model.startswith("or:")):
        return False
    if parsed.get("tools"):
        return False
    return _has_document_block(parsed)


def _content_blocks_to_openai(content) -> list[dict]:
    """Convert Anthropic content blocks → OpenAI Chat Completions parts."""
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, list):
        return [{"type": "text", "text": str(content)}]
    out: list[dict] = []
    file_counter = 0
    for block in content:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            txt = block.get("text") or ""
            if txt:
                out.append({"type": "text", "text": txt})
        elif btype == "image":
            src = block.get("source") or {}
            if src.get("type") == "base64" and src.get("data"):
                mt = src.get("media_type") or "image/png"
                out.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mt};base64,{src['data']}"},
                })
        elif btype == "document":
            src = block.get("source") or {}
            if src.get("type") == "base64" and src.get("data"):
                file_counter += 1
                mt = src.get("media_type") or "application/pdf"
                out.append({
                    "type": "file",
                    "file": {
                        "filename": f"attachment_{file_counter}.pdf",
                        "file_data": f"data:{mt};base64,{src['data']}",
                    },
                })
    if not out:
        out.append({"type": "text", "text": ""})
    return out


def translate_request(parsed: dict) -> dict:
    """Anthropic Messages request → OpenAI Chat Completions request."""
    model = parsed.get("model") or ""
    if "/" in model:
        model = model.split("/", 1)[1]
    openai_body: dict = {"model": model, "stream": True}

    sys = parsed.get("system")
    msgs_out: list[dict] = []
    if sys:
        if isinstance(sys, str):
            msgs_out.append({"role": "system", "content": sys})
        elif isinstance(sys, list):
            sys_text = "\n".join(
                b.get("text", "") for b in sys
                if isinstance(b, dict) and b.get("type") == "text"
            )
            if sys_text:
                msgs_out.append({"role": "system", "content": sys_text})

    for m in (parsed.get("messages") or []):
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        msgs_out.append({"role": role, "content": _content_blocks_to_openai(m.get("content"))})

    openai_body["messages"] = msgs_out
    mt = parsed.get("max_tokens")
    if isinstance(mt, int) and mt > 0:
        openai_body["max_completion_tokens"] = mt
    if isinstance(parsed.get("temperature"), (int, float)):
        openai_body["temperature"] = parsed["temperature"]
    # OpenAI omits usage from streamed chunks unless explicitly asked.
    # Without this, our Anthropic message_delta would always report 0
    # tokens, breaking cost tracking + the context meter for bypass-route
    # turns. OpenRouter respects the same flag.
    openai_body["stream_options"] = {"include_usage": True}
    return openai_body


def _sse_event(event: str, data: dict) -> bytes:
    """Encode an Anthropic-format SSE event."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode("utf-8")


async def _translate_response_stream(
    upstream: httpx.Response, model: str,
) -> AsyncIterator[bytes]:
    """Convert OpenAI Chat Completions SSE → Anthropic Messages SSE.

    Emits message_start, content_block_start (text block at index 0),
    content_block_delta per chunk, then content_block_stop +
    message_delta + message_stop on completion.
    """
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"
    started = False
    block_opened = False
    output_tokens = 0
    input_tokens = 0
    stop_reason = "end_turn"

    buffer = b""
    try:
        async for chunk in upstream.aiter_bytes():
            if not chunk:
                continue
            buffer += chunk
            while b"\n\n" in buffer:
                raw_event, buffer = buffer.split(b"\n\n", 1)
                line = raw_event.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                for ln in line.split("\n"):
                    # SSE comments (`:` prefix) are keep-alives, e.g.
                    # OpenRouter emits `: OPENROUTER PROCESSING` while
                    # its file-parser plugin works. Drop them.
                    if ln.startswith(":"):
                        continue
                    if not ln.startswith("data:"):
                        continue
                    payload = ln[5:].strip()
                    if payload == "[DONE]":
                        continue
                    try:
                        ev = json.loads(payload)
                    except Exception:
                        continue
                    if not started:
                        usage = (ev.get("usage") or {})
                        input_tokens = int(usage.get("prompt_tokens") or 0)
                        yield _sse_event("message_start", {
                            "type": "message_start",
                            "message": {
                                "id": msg_id,
                                "type": "message",
                                "role": "assistant",
                                "content": [],
                                "model": model,
                                "stop_reason": None,
                                "stop_sequence": None,
                                "usage": {
                                    "input_tokens": input_tokens,
                                    "output_tokens": 0,
                                },
                            },
                        })
                        started = True
                    choices = ev.get("choices") or []
                    if not choices:
                        usage = ev.get("usage") or {}
                        if usage:
                            output_tokens = int(usage.get("completion_tokens") or output_tokens)
                            input_tokens = int(usage.get("prompt_tokens") or input_tokens)
                        continue
                    choice = choices[0]
                    delta = choice.get("delta") or {}
                    delta_text = delta.get("content")
                    if isinstance(delta_text, str) and delta_text:
                        if not block_opened:
                            yield _sse_event("content_block_start", {
                                "type": "content_block_start",
                                "index": 0,
                                "content_block": {"type": "text", "text": ""},
                            })
                            block_opened = True
                        yield _sse_event("content_block_delta", {
                            "type": "content_block_delta",
                            "index": 0,
                            "delta": {"type": "text_delta", "text": delta_text},
                        })
                    finish = choice.get("finish_reason")
                    if finish:
                        if finish == "length":
                            stop_reason = "max_tokens"
                        elif finish == "tool_calls":
                            stop_reason = "tool_use"
                        else:
                            stop_reason = "end_turn"
    finally:
        if started:
            if block_opened:
                yield _sse_event("content_block_stop", {
                    "type": "content_block_stop", "index": 0,
                })
            yield _sse_event("message_delta", {
                "type": "message_delta",
                "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
            })
            yield _sse_event("message_stop", {"type": "message_stop"})


async def forward_to_openai(
    parsed: dict, api_key: str,
) -> tuple[int, AsyncIterator[bytes], dict[str, str]]:
    """Translate + forward an Anthropic request to OpenAI Chat Completions.
    Returns (status, body_stream, response_headers)."""
    openai_body = translate_request(parsed)
    return await _forward(openai_body, api_key, f"{_OPENAI_UPSTREAM}/chat/completions")


async def forward_to_openrouter(
    parsed: dict, api_key: str,
) -> tuple[int, AsyncIterator[bytes], dict[str, str]]:
    """Translate + forward to OpenRouter, injecting the file-parser plugin
    so any OR model parses the attached PDFs server-side."""
    openai_body = translate_request(parsed)
    model = (parsed.get("model") or "").lower()
    bare = model
    for prefix in ("openrouter/", "or:"):
        if bare.startswith(prefix):
            bare = bare[len(prefix):]
            break
    openai_body["model"] = bare
    openai_body["plugins"] = [{"id": "file-parser", "pdf": {"engine": "pdf-text"}}]
    return await _forward(openai_body, api_key, f"{_OPENROUTER_UPSTREAM}/chat/completions")


def _estimate_body_bytes(body_json: dict) -> int:
    """Sum the base64 payload bytes across content blocks. Used as a
    cheap pre-flight check before httpx serializes the body."""
    total = 0
    for m in body_json.get("messages") or []:
        content = m.get("content") if isinstance(m, dict) else None
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "image_url":
                url = (block.get("image_url") or {}).get("url") or ""
                if "," in url:
                    total += len(url.split(",", 1)[1])
            elif block.get("type") == "file":
                fd = (block.get("file") or {}).get("file_data") or ""
                if "," in fd:
                    total += len(fd.split(",", 1)[1])
    return total


async def _forward(
    body_json: dict, api_key: str, url: str,
) -> tuple[int, AsyncIterator[bytes], dict[str, str]]:
    # Pre-flight size check. base64 expands ~4/3 so 40MB raw → 53MB b64.
    raw_estimate = int(_estimate_body_bytes(body_json) * 0.75)
    if raw_estimate > _BYPASS_MAX_RAW_BYTES:

        async def reject():
            payload = json.dumps({
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "message": (
                        f"Attached files total ~{raw_estimate // (1024*1024)} MB, "
                        f"over the {_BYPASS_MAX_RAW_BYTES // (1024*1024)} MB per-request "
                        "cap on this provider lane. Detach a file or split across "
                        "separate turns."
                    ),
                },
            }).encode("utf-8")
            yield payload

        return 413, reject(), {"content-type": "application/json"}

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    # Acquire the bypass-concurrency semaphore before opening a streaming
    # connection. Without this, N simultaneous PDF attaches each hold a
    # ~40MB request body + a streaming response buffer, and the OS
    # OOM-kills the backend (observed on macOS during a 3-PDF probe
    # burst). Semaphore serializes excess requests instead of failing.
    await _bypass_sema.acquire()
    client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0))
    try:
        req = client.build_request("POST", url, json=body_json, headers=headers)
        upstream = await client.send(req, stream=True)
    except Exception:
        await client.aclose()
        _bypass_sema.release()
        raise

    async def streamer():
        try:
            if upstream.status_code >= 400:
                raw = await upstream.aread()
                yield raw
                return
            async for chunk in _translate_response_stream(upstream, body_json["model"]):
                yield chunk
        finally:
            try:
                await upstream.aclose()
            finally:
                try:
                    await client.aclose()
                finally:
                    _bypass_sema.release()

    return upstream.status_code, streamer(), {
        "content-type": "text/event-stream" if upstream.status_code < 400 else "application/json",
    }
