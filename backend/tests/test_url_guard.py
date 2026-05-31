"""SSRF guard: WebFetch must refuse non-http(s) schemes and any host that
resolves to a private/loopback/link-local/cloud-metadata address, including
after a redirect 30x-pivots toward the LAN."""
import asyncio

import pytest

from backend.apps.agents.tools.url_guard import (
    BlockedURLError,
    fetch_guarded,
    validate_fetch_url,
)


# ---------------- validate_fetch_url: schemes ----------------

@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "ftp://internal/secret",
    "gopher://169.254.169.254/",
    "data:text/html,<script>",
    "//169.254.169.254/",
])
def test_rejects_non_http_schemes(url):
    with pytest.raises(BlockedURLError):
        validate_fetch_url(url)


# ---------------- validate_fetch_url: IP literals ----------------

@pytest.mark.parametrize("url", [
    "http://169.254.169.254/latest/meta-data/",   # AWS/GCP metadata
    "http://127.0.0.1/",                            # loopback
    "http://localhost/",                            # loopback by name (resolves)
    "http://10.0.0.5/",                             # private
    "http://192.168.1.1/",                          # private
    "http://172.16.0.1/",                           # private
    "http://[::1]/",                                # ipv6 loopback
    "http://[fd00::1]/",                            # ipv6 unique-local
    "http://0.0.0.0/",                              # unspecified
])
def test_rejects_internal_ip_literals(url):
    with pytest.raises(BlockedURLError):
        validate_fetch_url(url)


def test_rejects_url_with_no_host():
    with pytest.raises(BlockedURLError):
        validate_fetch_url("http:///nohost")


def test_allows_public_ip_literal():
    validate_fetch_url("https://8.8.8.8/")  # public, should not raise


# ---------------- fetch_guarded: redirect pivot ----------------

class _Resp:
    def __init__(self, location=None):
        self.is_redirect = location is not None
        self.headers = {"location": location} if location else {}
        self.next_request = None
        if location:
            class _Req:
                url = location
            self.next_request = _Req()


class _FakeClient:
    """Records every URL it was asked to GET so we can assert the guard
    blocks before the request, not after."""
    def __init__(self, script):
        self._script = script
        self.requested = []

    async def get(self, url):
        self.requested.append(url)
        return self._script.pop(0)


def test_redirect_to_internal_is_blocked_before_request():
    # public URL 30x to metadata; the second hop must be validated and blocked,
    # and we must never GET the internal address.
    client = _FakeClient([_Resp(location="http://169.254.169.254/latest/")])
    with pytest.raises(BlockedURLError):
        asyncio.run(fetch_guarded(client, "https://example.com/start"))
    assert client.requested == ["https://example.com/start"]


def test_redirect_loop_caps_out():
    script = [_Resp(location="https://example.com/again") for _ in range(20)]
    client = _FakeClient(script)
    with pytest.raises(BlockedURLError):
        asyncio.run(fetch_guarded(client, "https://example.com/start"))


def test_non_redirect_response_returned():
    final = _Resp()
    client = _FakeClient([final])
    out = asyncio.run(fetch_guarded(client, "https://example.com/page"))
    assert out is final
