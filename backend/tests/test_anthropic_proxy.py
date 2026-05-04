"""Tests for `backend.apps.agents.anthropic_proxy`.

The proxy splits Anthropic-format traffic between the OpenSwarm Pro
cloud proxy (for Claude models on a Pro subscription) and 9Router
(everything else).

Coverage targets:
  - `_is_claude_model` parameterized over expected matches/non-matches
  - `_pick_upstream`:
      - openswarm-pro + Claude → Pro proxy with bearer token
      - non-Claude model → 9Router with `x-api-key: 9router`
      - Claude + own_key → 9Router (Pro fallthrough)
  - `_healthcheck` returns 200
  - non-streaming proxy:
      - body round-trips
      - JSON content-type bodies parsed; non-JSON wrapped as `{"raw": ...}`
      - hop headers / x-api-key / authorization stripped before forward
      - timeout → 504, generic exception → 502
  - streaming proxy:
      - returns StreamingResponse with chunks from upstream
      - `stream:true` honored
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from backend.apps.agents import anthropic_proxy as proxy_mod
from backend.apps.agents.anthropic_proxy import (
    _HOP_HEADERS,
    _is_claude_model,
    _pick_upstream,
)
from backend.apps.settings.models import AppSettings


# ---------------------------------------------------------------------------
# _is_claude_model
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "model,expected",
    [
        ("claude-sonnet-4-6", True),
        ("claude/claude-3", True),
        ("claude-opus-4-6", True),
        ("sonnet", True),
        ("opus", True),
        ("haiku", True),
        ("cc/claude-sonnet-4-6", True),
        ("CLAUDE-haiku-4-5", True),  # case insensitive
        ("  sonnet  ", True),  # whitespace trimmed
        ("cx/gpt-5.4", False),
        ("gc/gemini-3-pro-preview", False),
        ("gpt-5.4", False),
        ("gemini-2.5-pro", False),
        ("", False),
    ],
)
def test_is_claude_model(model: str, expected: bool):
    assert _is_claude_model(model) is expected


# ---------------------------------------------------------------------------
# _pick_upstream
# ---------------------------------------------------------------------------


def test_pick_upstream_claude_with_openswarm_pro_returns_proxy_with_bearer():
    s = AppSettings(
        connection_mode="openswarm-pro",
        openswarm_bearer_token="bearer-x",
        openswarm_proxy_url="https://api.openswarm.com",
    )
    with patch("backend.apps.settings.settings.load_settings", return_value=s):
        base, headers = _pick_upstream("claude-sonnet-4-6")
    assert base == "https://api.openswarm.com"
    assert headers == {"Authorization": "Bearer bearer-x"}


def test_pick_upstream_claude_pro_strips_trailing_slash():
    s = AppSettings(
        connection_mode="openswarm-pro",
        openswarm_bearer_token="bearer-x",
        openswarm_proxy_url="https://api.openswarm.com/",
    )
    with patch("backend.apps.settings.settings.load_settings", return_value=s):
        base, _ = _pick_upstream("sonnet")
    assert base == "https://api.openswarm.com"  # no trailing /


def test_pick_upstream_non_claude_returns_9router():
    s = AppSettings(connection_mode="openswarm-pro", openswarm_bearer_token="bearer-x")
    with patch("backend.apps.settings.settings.load_settings", return_value=s):
        base, headers = _pick_upstream("cx/gpt-5.4")
    assert base == "http://127.0.0.1:20128"
    assert headers == {"x-api-key": "9router"}


def test_pick_upstream_claude_own_key_falls_back_to_9router():
    """When connection_mode != openswarm-pro, a Claude model still routes
    through 9Router (the user might have a Claude subscription wired)."""
    s = AppSettings(connection_mode="own_key", anthropic_api_key="sk-foo")
    with patch("backend.apps.settings.settings.load_settings", return_value=s):
        base, headers = _pick_upstream("claude-sonnet-4-6")
    assert base == "http://127.0.0.1:20128"
    assert headers == {"x-api-key": "9router"}


def test_pick_upstream_pro_without_bearer_falls_back_to_9router():
    """openswarm-pro mode but no bearer token → can't reach the Pro proxy,
    fall through to 9Router."""
    s = AppSettings(connection_mode="openswarm-pro")  # no bearer
    with patch("backend.apps.settings.settings.load_settings", return_value=s):
        base, headers = _pick_upstream("claude-sonnet-4-6")
    assert base == "http://127.0.0.1:20128"
    assert headers == {"x-api-key": "9router"}


def test_pick_upstream_pro_default_proxy_url():
    """Empty `openswarm_proxy_url` defaults to https://api.openswarm.com."""
    s = AppSettings(
        connection_mode="openswarm-pro",
        openswarm_bearer_token="bearer-x",
    )
    with patch("backend.apps.settings.settings.load_settings", return_value=s):
        base, _ = _pick_upstream("claude-sonnet-4-6")
    assert base == "https://api.openswarm.com"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def test_healthcheck_via_test_client(client):
    """GET on the proxy root must return 200 (CLI healthcheck path)."""
    r = client.get("/api/anthropic-proxy")
    assert r.status_code in (200, 307, 308)
    if r.status_code == 200:
        assert r.json() == {"ok": True}


def test_healthcheck_via_test_client_trailing_slash(client):
    r = client.get("/api/anthropic-proxy/")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


# ---------------------------------------------------------------------------
# Non-streaming proxy
# ---------------------------------------------------------------------------


def _make_async_client_mock(response):
    """Build a context-managed async client whose `request` returns
    `response`. Mirrors `httpx.AsyncClient(...)` ergonomics."""
    inst = MagicMock()
    inst.request = AsyncMock(return_value=response)
    inst.__aenter__ = AsyncMock(return_value=inst)
    inst.__aexit__ = AsyncMock(return_value=False)
    return inst


def test_proxy_non_streaming_routes_claude_to_pro_proxy(client):
    """Claude model + Pro mode → upstream URL is the Pro proxy with
    bearer auth. Body and headers round-trip; x-api-key is stripped."""
    s = AppSettings(
        connection_mode="openswarm-pro",
        openswarm_bearer_token="bearer-x",
        openswarm_proxy_url="https://api.openswarm.com",
    )
    upstream_resp = httpx.Response(
        status_code=200,
        headers={"content-type": "application/json"},
        content=b'{"id": "msg_1", "model": "claude-sonnet-4-6"}',
    )
    captured: dict[str, Any] = {}

    async def fake_request(method, url, content=None, headers=None, params=None):
        captured["method"] = method
        captured["url"] = url
        captured["body"] = content
        captured["headers"] = headers or {}
        return upstream_resp

    fake_client = MagicMock()
    fake_client.request = AsyncMock(side_effect=fake_request)
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.settings.settings.load_settings", return_value=s), \
         patch.object(proxy_mod.httpx, "AsyncClient", return_value=fake_client):
        r = client.post(
            "/api/anthropic-proxy/v1/messages",
            json={"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "hi"}]},
            headers={"x-api-key": "should-not-leak", "x-extra": "passthrough"},
        )

    assert r.status_code == 200
    assert r.json() == {"id": "msg_1", "model": "claude-sonnet-4-6"}
    # Routed to Pro proxy
    assert captured["url"] == "https://api.openswarm.com/v1/messages"
    # Bearer auth attached
    assert captured["headers"].get("Authorization") == "Bearer bearer-x"
    # x-api-key NEVER reaches upstream
    keys = {k.lower() for k in captured["headers"].keys()}
    assert "x-api-key" not in keys
    # Hop headers stripped
    for hop in ("host", "content-length", "connection"):
        assert hop not in keys
    # Custom headers passed through
    assert captured["headers"].get("x-extra") == "passthrough"
    # Body round-tripped
    assert json.loads(captured["body"]) == {
        "model": "claude-sonnet-4-6",
        "messages": [{"role": "user", "content": "hi"}],
    }


def test_proxy_non_streaming_routes_non_claude_to_9router(client):
    """Non-Claude model → 9Router with x-api-key=9router header."""
    s = AppSettings(connection_mode="openswarm-pro", openswarm_bearer_token="bearer-x")
    upstream_resp = httpx.Response(
        status_code=200,
        headers={"content-type": "application/json"},
        content=b'{"id": "msg_2"}',
    )
    captured: dict[str, Any] = {}

    async def fake_request(method, url, content=None, headers=None, params=None):
        captured["url"] = url
        captured["headers"] = headers or {}
        return upstream_resp

    fake_client = MagicMock()
    fake_client.request = AsyncMock(side_effect=fake_request)
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.settings.settings.load_settings", return_value=s), \
         patch.object(proxy_mod.httpx, "AsyncClient", return_value=fake_client):
        r = client.post(
            "/api/anthropic-proxy/v1/messages",
            json={"model": "cx/gpt-5.4"},
        )

    assert r.status_code == 200
    assert captured["url"] == "http://127.0.0.1:20128/v1/messages"
    assert captured["headers"].get("x-api-key") == "9router"
    assert "Authorization" not in captured["headers"]


def test_proxy_non_streaming_non_json_body_wrapped_in_raw(client):
    """Upstream returning text/plain → body wrapped as {"raw": "..."}."""
    s = AppSettings()
    upstream_resp = httpx.Response(
        status_code=200,
        headers={"content-type": "text/plain"},
        content=b"hello",
    )
    fake_client = MagicMock()
    fake_client.request = AsyncMock(return_value=upstream_resp)
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.settings.settings.load_settings", return_value=s), \
         patch.object(proxy_mod.httpx, "AsyncClient", return_value=fake_client):
        r = client.post(
            "/api/anthropic-proxy/v1/messages",
            json={"model": "cx/gpt-5.4"},
        )
    assert r.status_code == 200
    assert r.json() == {"raw": "hello"}


def test_proxy_non_streaming_timeout_returns_504(client):
    s = AppSettings()
    fake_client = MagicMock()
    fake_client.request = AsyncMock(side_effect=httpx.TimeoutException("timed out"))
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.settings.settings.load_settings", return_value=s), \
         patch.object(proxy_mod.httpx, "AsyncClient", return_value=fake_client):
        r = client.post(
            "/api/anthropic-proxy/v1/messages",
            json={"model": "cx/gpt-5.4"},
        )
    assert r.status_code == 504
    assert r.json()["error"] == "upstream timeout"


def test_proxy_non_streaming_generic_exception_returns_502(client):
    s = AppSettings()
    fake_client = MagicMock()
    fake_client.request = AsyncMock(side_effect=RuntimeError("kaboom"))
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.settings.settings.load_settings", return_value=s), \
         patch.object(proxy_mod.httpx, "AsyncClient", return_value=fake_client):
        r = client.post(
            "/api/anthropic-proxy/v1/messages",
            json={"model": "cx/gpt-5.4"},
        )
    assert r.status_code == 502
    assert "kaboom" in r.json()["error"]


def test_proxy_non_streaming_non_json_body_doesnt_break_routing(client):
    """If the body isn't valid JSON, model is "" → routes to 9Router
    via the non-Claude branch. Must not crash."""
    s = AppSettings()
    upstream_resp = httpx.Response(status_code=200, content=b"{}",
                                   headers={"content-type": "application/json"})
    fake_client = MagicMock()
    fake_client.request = AsyncMock(return_value=upstream_resp)
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.settings.settings.load_settings", return_value=s), \
         patch.object(proxy_mod.httpx, "AsyncClient", return_value=fake_client):
        r = client.post(
            "/api/anthropic-proxy/v1/messages",
            content=b"not-json-at-all",
            headers={"content-type": "application/json"},
        )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Streaming proxy
# ---------------------------------------------------------------------------


def test_proxy_streaming_returns_chunks(client):
    """`stream:true` body → StreamingResponse with raw chunks from
    upstream's aiter_raw."""
    s = AppSettings()

    upstream = MagicMock()
    upstream.status_code = 200
    upstream.headers = {"content-type": "text/event-stream"}

    async def aiter_raw():
        yield b"event: message\n"
        yield b"data: hello\n\n"

    upstream.aiter_raw = aiter_raw
    upstream.aclose = AsyncMock()

    fake_client = MagicMock()
    fake_client.build_request = MagicMock(return_value=MagicMock())
    fake_client.send = AsyncMock(return_value=upstream)
    fake_client.aclose = AsyncMock()

    with patch("backend.apps.settings.settings.load_settings", return_value=s), \
         patch.object(proxy_mod.httpx, "AsyncClient", return_value=fake_client):
        r = client.post(
            "/api/anthropic-proxy/v1/messages",
            json={"model": "cx/gpt-5.4", "stream": True},
        )

    assert r.status_code == 200
    body = r.content
    assert b"event: message" in body
    assert b"data: hello" in body
    fake_client.send.assert_awaited_once()


def test_proxy_streaming_stream_false_takes_non_streaming_path(client):
    """Body with `stream:false` → goes through the non-streaming branch
    (no StreamingResponse)."""
    s = AppSettings()
    upstream_resp = httpx.Response(
        status_code=200,
        headers={"content-type": "application/json"},
        content=b'{"ok": true}',
    )
    fake_client = MagicMock()
    fake_client.request = AsyncMock(return_value=upstream_resp)
    fake_client.send = AsyncMock(side_effect=AssertionError("send must NOT be called"))
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.settings.settings.load_settings", return_value=s), \
         patch.object(proxy_mod.httpx, "AsyncClient", return_value=fake_client):
        r = client.post(
            "/api/anthropic-proxy/v1/messages",
            json={"model": "cx/gpt-5.4", "stream": False},
        )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Constants sanity
# ---------------------------------------------------------------------------


def test_hop_headers_lowercase():
    """Hop-by-hop headers must be lowercased so the comparison in
    proxy() works (`k.lower() in _HOP_HEADERS`)."""
    for h in _HOP_HEADERS:
        assert h == h.lower()
