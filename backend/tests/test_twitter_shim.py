"""Shim tests: JSON-RPC framing + HTTP-to-backend translation.

We don't spawn a subprocess; instead we patch `urllib.request.urlopen`
to fake the backend's HTTP responses and call `handle_tool_call` /
`main()` directly. That keeps the test fast and lets us assert the
shim's response shape (MCP content/isError) deterministically.

Critical behaviors covered:

- Auth-token reading: shim picks up a token rotation between calls
  (re-reads the file rather than caching forever).
- HTTP 429 -> MCP error content carrying retry_after_s.
- HTTP 409 (account locked/needs_relogin) -> MCP error.
- 200 with payload -> non-error MCP content.
- Missing required arg -> early MCP error without calling the backend.
- The JSON-RPC framing for initialize/tools/list/tools/call matches
  the shape mcp clients expect.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def fresh_shim(monkeypatch):
    """Re-import the shim with a chosen env so each test gets clean state.

    `OPENSWARM_AUTH_TOKEN_FILE` etc. are read at module-import time;
    re-importing forces the env to take effect.
    """
    with tempfile.TemporaryDirectory() as tmp:
        token_file = os.path.join(tmp, "auth.token")
        with open(token_file, "w") as f:
            f.write("token-v1")
        monkeypatch.setenv("OPENSWARM_AUTH_TOKEN_FILE", token_file)
        monkeypatch.setenv("OPENSWARM_AUTH_TOKEN", "")  # avoid env fallback masking the file test
        monkeypatch.setenv("OPENSWARM_BASE_URL", "http://127.0.0.1:8324")

        if "backend.apps.twitter_mcp_shim.server" in sys.modules:
            del sys.modules["backend.apps.twitter_mcp_shim.server"]
        import backend.apps.twitter_mcp_shim.server as server  # noqa: E402

        yield {"server": server, "token_file": token_file}


def _fake_urlopen(status: int, body):
    """Build a context-manager-style mock matching urlopen()'s return shape."""
    class _Resp:
        def __init__(self):
            self.status = status
            payload = json.dumps(body).encode() if not isinstance(body, (bytes, str)) else (
                body.encode() if isinstance(body, str) else body
            )
            self._payload = payload

        def read(self):
            return self._payload

        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

    return _Resp()


def _fake_http_error(code: int, body):
    """Build a `urllib.error.HTTPError` mimicking a non-2xx response."""
    import urllib.error

    payload = json.dumps(body).encode() if not isinstance(body, str) else body.encode()
    fp = io.BytesIO(payload)
    return urllib.error.HTTPError(
        url="http://x/", code=code, msg="error", hdrs=None, fp=fp,
    )


# ---------------------------------------------------------------------------
# Token plumbing
# ---------------------------------------------------------------------------

def test_token_read_from_file(fresh_shim):
    server = fresh_shim["server"]
    assert server._read_token() == "token-v1"


def test_token_rotation_picked_up_after_cache_ttl(fresh_shim, monkeypatch):
    """After the cache TTL, the shim should re-read the file."""
    server = fresh_shim["server"]
    assert server._read_token() == "token-v1"

    with open(fresh_shim["token_file"], "w") as f:
        f.write("token-v2")

    # Fast-forward past the cache TTL.
    import time as t
    monkeypatch.setattr(server, "_token_cache", (t.time() - 100.0, "token-v1"))
    assert server._read_token() == "token-v2"


def test_token_falls_back_to_env_when_file_missing(monkeypatch):
    monkeypatch.setenv("OPENSWARM_AUTH_TOKEN_FILE", "/nope/never/exists.token")
    monkeypatch.setenv("OPENSWARM_AUTH_TOKEN", "env-only-token")
    if "backend.apps.twitter_mcp_shim.server" in sys.modules:
        del sys.modules["backend.apps.twitter_mcp_shim.server"]
    import backend.apps.twitter_mcp_shim.server as server  # noqa: E402
    assert server._read_token() == "env-only-token"


# ---------------------------------------------------------------------------
# Tool dispatch -> HTTP
# ---------------------------------------------------------------------------

def test_search_happy_path(fresh_shim):
    server = fresh_shim["server"]
    with patch.object(server.urllib.request, "urlopen") as urlopen_mock:
        urlopen_mock.return_value = _fake_urlopen(200, {"items": [{"id": "1"}], "next_cursor": None})
        result = server.handle_tool_call("twitter_search", {"q": "hello"})
    assert "isError" not in result, result
    # Payload arrives as JSON string in `content[0].text`.
    text = result["content"][0]["text"]
    parsed = json.loads(text)
    assert parsed["items"][0]["id"] == "1"


def test_search_missing_q_is_local_error(fresh_shim):
    server = fresh_shim["server"]
    with patch.object(server.urllib.request, "urlopen") as urlopen_mock:
        result = server.handle_tool_call("twitter_search", {"q": "   "})
    assert result.get("isError") is True
    # Backend must not be called when required args are missing.
    urlopen_mock.assert_not_called()


def test_get_user_requires_exactly_one_arg(fresh_shim):
    server = fresh_shim["server"]
    with patch.object(server.urllib.request, "urlopen") as urlopen_mock:
        r1 = server.handle_tool_call("twitter_get_user", {})
        r2 = server.handle_tool_call("twitter_get_user", {"handle": "x", "user_id": "1"})
    assert r1.get("isError") is True
    assert r2.get("isError") is True
    urlopen_mock.assert_not_called()


def test_get_user_strips_at_prefix(fresh_shim):
    server = fresh_shim["server"]
    with patch.object(server.urllib.request, "urlopen") as urlopen_mock:
        urlopen_mock.return_value = _fake_urlopen(200, {"handle": "openai"})
        server.handle_tool_call("twitter_get_user", {"handle": "@openai"})
    # Assert we sent `?handle=openai`, not `?handle=@openai`.
    sent_req = urlopen_mock.call_args[0][0]
    assert "handle=openai" in sent_req.full_url
    assert "%40" not in sent_req.full_url


# ---------------------------------------------------------------------------
# HTTP status -> MCP response mapping
# ---------------------------------------------------------------------------

def test_429_surfaces_retry_after(fresh_shim):
    """The shim must translate {retry_after_s} into agent-readable text."""
    server = fresh_shim["server"]
    with patch.object(server.urllib.request, "urlopen") as urlopen_mock:
        urlopen_mock.side_effect = _fake_http_error(429, {
            "retry_after_s": 47,
            "endpoint": "search_tweet",
        })
        result = server.handle_tool_call("twitter_search", {"q": "hi"})
    assert result.get("isError") is True
    text = result["content"][0]["text"]
    assert "47 seconds" in text
    assert "search_tweet" in text


def test_409_surfaces_account_state_error(fresh_shim):
    server = fresh_shim["server"]
    with patch.object(server.urllib.request, "urlopen") as urlopen_mock:
        urlopen_mock.side_effect = _fake_http_error(409, {"error": "Account is locked"})
        result = server.handle_tool_call("twitter_search", {"q": "hi"})
    assert result.get("isError") is True
    assert "locked" in result["content"][0]["text"].lower()


def test_503_surfaces_no_account_error(fresh_shim):
    server = fresh_shim["server"]
    with patch.object(server.urllib.request, "urlopen") as urlopen_mock:
        urlopen_mock.side_effect = _fake_http_error(503, {"error": "No active Twitter account"})
        result = server.handle_tool_call("twitter_search", {"q": "hi"})
    assert result.get("isError") is True
    assert "no active" in result["content"][0]["text"].lower()


def test_backend_unreachable_surfaces_clean_error(fresh_shim):
    """If urlopen raises URLError, we should return an MCP error, not crash."""
    import urllib.error
    server = fresh_shim["server"]
    with patch.object(server.urllib.request, "urlopen") as urlopen_mock:
        urlopen_mock.side_effect = urllib.error.URLError("connection refused")
        result = server.handle_tool_call("twitter_search", {"q": "hi"})
    assert result.get("isError") is True


def test_401_triggers_single_token_refresh_retry(fresh_shim):
    """A 401 should bust the token cache and retry exactly once.

    The cache TTL is 5s; without retry the shim would 401-loop for
    that long after a backend restart rotated the token. The test
    rotates the file mid-call and checks that the second urlopen got
    the new token.
    """
    server = fresh_shim["server"]

    # Sequence: first call -> 401, second call -> 200. Capture
    # Authorization headers from each Request to confirm we re-read.
    seen_tokens = []

    def fake_urlopen(req, *_a, **_kw):
        seen_tokens.append(req.headers.get("Authorization"))
        if len(seen_tokens) == 1:
            raise _fake_http_error(401, {"error": "unauthorized"})
        return _fake_urlopen(200, {"ok": True})

    # Rotate the on-disk token between the two calls. The first
    # `_read_token()` already populated the cache with "token-v1".
    # When we 401, the cache is busted, so the second `_read_token()`
    # reads the rotated file.
    with patch.object(server.urllib.request, "urlopen", side_effect=fake_urlopen):
        # Pre-warm the cache so the first call carries token-v1.
        assert server._read_token() == "token-v1"
        with open(fresh_shim["token_file"], "w") as f:
            f.write("token-v2")
        result = server.handle_tool_call("twitter_search", {"q": "hi"})

    assert "isError" not in result, result
    assert seen_tokens == ["Bearer token-v1", "Bearer token-v2"]


def test_401_does_not_retry_more_than_once(fresh_shim):
    """If the token rotation didn't fix the 401, surface it (don't loop)."""
    server = fresh_shim["server"]
    n_calls = []

    def fake_urlopen(req, *_a, **_kw):
        n_calls.append(1)
        raise _fake_http_error(401, {"error": "unauthorized"})

    with patch.object(server.urllib.request, "urlopen", side_effect=fake_urlopen):
        result = server.handle_tool_call("twitter_search", {"q": "hi"})

    assert result.get("isError") is True
    # Two attempts: original + one retry. Not three.
    assert len(n_calls) == 2


# ---------------------------------------------------------------------------
# JSON-RPC framing
# ---------------------------------------------------------------------------

def _drive_stdio(server, requests: list[dict]) -> list[dict]:
    """Feed a sequence of JSON-RPC frames through `main()` and capture replies."""
    stdin = io.StringIO("\n".join(json.dumps(r) for r in requests) + "\n")
    stdout = io.StringIO()
    with patch.object(server.sys, "stdin", stdin), patch.object(server.sys, "stdout", stdout):
        server.main()
    out = stdout.getvalue().splitlines()
    return [json.loads(line) for line in out if line.strip()]


def test_stdio_initialize_returns_protocol_metadata(fresh_shim):
    server = fresh_shim["server"]
    replies = _drive_stdio(server, [{"jsonrpc": "2.0", "id": 1, "method": "initialize"}])
    assert len(replies) == 1
    assert replies[0]["id"] == 1
    assert replies[0]["result"]["serverInfo"]["name"] == "openswarm-twitter"
    assert "tools" in replies[0]["result"]["capabilities"]


def test_stdio_tools_list_returns_five_tools(fresh_shim):
    server = fresh_shim["server"]
    replies = _drive_stdio(server, [{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}])
    names = [t["name"] for t in replies[0]["result"]["tools"]]
    assert names == [
        "twitter_search",
        "twitter_get_user",
        "twitter_get_user_tweets",
        "twitter_get_tweet",
        "twitter_get_tweet_replies",
    ]


def test_stdio_tools_call_routes_through_handle(fresh_shim):
    server = fresh_shim["server"]
    with patch.object(server.urllib.request, "urlopen") as urlopen_mock:
        urlopen_mock.return_value = _fake_urlopen(200, {"items": []})
        replies = _drive_stdio(server, [{
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "twitter_search", "arguments": {"q": "hi"}},
        }])
    assert replies[0]["id"] == 5
    assert "content" in replies[0]["result"]
    assert "isError" not in replies[0]["result"]


def test_stdio_unknown_method_returns_jsonrpc_error(fresh_shim):
    server = fresh_shim["server"]
    replies = _drive_stdio(server, [{"jsonrpc": "2.0", "id": 9, "method": "bogus"}])
    assert replies[0]["error"]["code"] == -32601


def test_stdio_ping_works(fresh_shim):
    """MCP clients ping to keep the connection alive."""
    server = fresh_shim["server"]
    replies = _drive_stdio(server, [{"jsonrpc": "2.0", "id": 10, "method": "ping"}])
    assert replies[0] == {"jsonrpc": "2.0", "id": 10, "result": {}}
