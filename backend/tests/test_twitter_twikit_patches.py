"""Tests for the runtime twikit patches.

These guard the regex + header changes we apply at import time as a workaround
for twikit#408. They do *not* hit the network; everything is exercised against
synthetic minified-JS snippets crafted to mimic the pre- and post-rotation
shapes that X has shipped.

If twikit ships a real fix and we delete `_twikit_patches.py`, these tests
should be deleted with it.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.apps.twitter import _twikit_patches

# Capture pristine twikit state *before* any test triggers the patch. We use
# these to fully unwind monkey-patched classes between tests so each test
# starts with a clean twikit, exercises `apply()`, and leaves no residue for
# the next one. Without this the autouse fixture's re-apply on teardown would
# leak Client.__init__ wrapping into the next test, breaking the
# "patch is disabled" assertions.
from twikit.client.client import Client as _Client  # noqa: E402
from twikit.x_client_transaction import transaction as _tx_mod  # noqa: E402

_PRISTINE_CLIENT_INIT = _Client.__init__
_PRISTINE_CLIENT_BASE_HEADERS = _Client._base_headers
_PRISTINE_TX_GET_INDICES = _tx_mod.ClientTransaction.get_indices
_PRISTINE_INDICES_REGEX = _tx_mod.INDICES_REGEX
_PRISTINE_ON_DEMAND_FILE_REGEX = _tx_mod.ON_DEMAND_FILE_REGEX


def _restore_pristine_twikit() -> None:
    _Client.__init__ = _PRISTINE_CLIENT_INIT
    _Client._base_headers = _PRISTINE_CLIENT_BASE_HEADERS
    _tx_mod.ClientTransaction.get_indices = _PRISTINE_TX_GET_INDICES
    _tx_mod.INDICES_REGEX = _PRISTINE_INDICES_REGEX
    _tx_mod.ON_DEMAND_FILE_REGEX = _PRISTINE_ON_DEMAND_FILE_REGEX
    _twikit_patches._APPLIED_TX = False
    _twikit_patches._APPLIED_HEADERS = False


@pytest.fixture(autouse=True)
def _reapply_patch():
    """Reset twikit to its pristine state for each test, then re-apply the
    real patch on teardown so subsequent suites (and the running process)
    see the same patched state production does."""
    _restore_pristine_twikit()
    yield
    _restore_pristine_twikit()
    _twikit_patches.apply()


def test_apply_is_idempotent():
    """Calling apply twice should not raise and should report success both times."""
    assert _twikit_patches.apply() is True
    assert _twikit_patches.apply() is True


def test_apply_skipped_when_both_env_disabled(monkeypatch):
    monkeypatch.setenv("OPENSWARM_TWITTER_DISABLE_TWIKIT_PATCH", "1")
    monkeypatch.setenv("OPENSWARM_TWITTER_DISABLE_TWIKIT_HEADER_PATCH", "1")
    assert _twikit_patches.apply() is False


def test_apply_returns_true_when_only_transaction_disabled(monkeypatch):
    """Disabling just one patch should still let the other apply."""
    monkeypatch.setenv("OPENSWARM_TWITTER_DISABLE_TWIKIT_PATCH", "1")
    assert _twikit_patches.apply() is True
    assert _twikit_patches._APPLIED_TX is False
    assert _twikit_patches._APPLIED_HEADERS is True


def test_apply_returns_true_when_only_header_disabled(monkeypatch):
    monkeypatch.setenv("OPENSWARM_TWITTER_DISABLE_TWIKIT_HEADER_PATCH", "1")
    assert _twikit_patches.apply() is True
    assert _twikit_patches._APPLIED_TX is True
    assert _twikit_patches._APPLIED_HEADERS is False


def test_indices_regex_matches_post_rotation_two_char_var():
    """The new minified output uses 1-2 char variable names like `xx[NN]`.
    Original regex (`\\w{1}`) missed this; our replacement (`\\w{1,2}`) must
    capture both the byte index and the modulus marker."""
    _twikit_patches.apply()
    from twikit.x_client_transaction import transaction as _tx

    sample = "...computeKey:function(xx){return(xx[13],16),(xx[14],16),(xx[7],16)}..."
    matches = [m.group(2) for m in _tx.INDICES_REGEX.finditer(sample)]
    assert matches == ["13", "14", "7"]


def test_indices_regex_still_matches_pre_rotation_single_char_var():
    """Backwards-compat: if X ever rolls back to one-char names, we should
    keep working without another patch."""
    _twikit_patches.apply()
    from twikit.x_client_transaction import transaction as _tx

    sample = "...(x[2],16),(x[42],16),(x[45],16)..."
    matches = [m.group(2) for m in _tx.INDICES_REGEX.finditer(sample)]
    assert matches == ["2", "42", "45"]


def test_on_demand_file_regex_extracts_chunk_index():
    """The new home-page chunk map embeds `,NN:"ondemand.s"`; our regex
    pulls out NN so the follow-up hash lookup can find the right chunk."""
    _twikit_patches.apply()
    from twikit.x_client_transaction import transaction as _tx

    sample = '...,99:"prev",964:"ondemand.s",100:"next",964:"deadbeef1234"...'
    match = _tx.ON_DEMAND_FILE_REGEX.search(sample)
    assert match is not None
    assert match.group(1) == "964"


def test_on_demand_hash_pattern_resolves_to_chunk_hash():
    """The second-pass lookup must find the hash for the chunk index
    returned by ON_DEMAND_FILE_REGEX."""
    import re

    _twikit_patches.apply()
    from twikit.x_client_transaction import transaction as _tx

    sample = '...,99:"prev",964:"ondemand.s",100:"next",964:"deadbeef1234"...'
    hash_re = re.compile(_tx.ON_DEMAND_HASH_PATTERN.format("964"))
    match = hash_re.search(sample)
    assert match is not None
    assert match.group(1) == "deadbeef1234"


def test_get_indices_extracts_full_index_list_from_synthetic_payload():
    """End-to-end exercise of the patched `get_indices` against a fake bs4
    response + fake httpx session that returns a synthetic minified JS body
    matching the post-rotation INDICES_REGEX shape."""

    import bs4

    _twikit_patches.apply()
    from twikit.x_client_transaction import transaction as _tx

    home_html = (
        '<html><head></head><body>'
        '<script>'
        '...,99:"prev",964:"ondemand.s",100:"next",964:"abcdef0123"...'
        '</script>'
        '</body></html>'
    )
    home_soup = bs4.BeautifulSoup(home_html, "html.parser")

    on_demand_js = "function k(xx){return(xx[2],16),(xx[12],16),(xx[7],16)}"

    class _FakeResponse:
        def __init__(self, text: str) -> None:
            self.text = text

    class _FakeSession:
        def __init__(self, body: str) -> None:
            self._body = body
            self.calls: list[tuple[str, str]] = []

        async def request(self, method: str, url: str, headers: Any) -> _FakeResponse:
            self.calls.append((method, url))
            return _FakeResponse(self._body)

    session = _FakeSession(on_demand_js)

    ct = _tx.ClientTransaction()
    ct.home_page_response = home_soup

    row_index, byte_indices = asyncio.run(
        ct.get_indices(home_soup, session, headers={})
    )

    assert row_index == 2
    assert byte_indices == [12, 7]
    assert session.calls == [
        (
            "GET",
            "https://abs.twimg.com/responsive-web/client-web/ondemand.s.abcdef0123a.js",
        )
    ]


def test_get_indices_raises_legacy_exception_when_payload_empty():
    """If neither pass finds anything, surface the exact same exception
    string the unpatched library raises. This keeps the SubApp's lifecycle
    audit log ('Couldn't get KEY_BYTE indices') and the smoke probe's drift
    detection both pointing at the right symptom."""

    import bs4

    _twikit_patches.apply()
    from twikit.x_client_transaction import transaction as _tx

    home_soup = bs4.BeautifulSoup(
        "<html><body><script>nothing useful here</script></body></html>",
        "html.parser",
    )

    class _NeverCalledSession:
        async def request(self, *args: Any, **kwargs: Any):  # pragma: no cover
            raise AssertionError("session should not be hit when home page has no chunk map")

    ct = _tx.ClientTransaction()
    ct.home_page_response = home_soup

    with pytest.raises(Exception, match="Couldn't get KEY_BYTE indices"):
        asyncio.run(ct.get_indices(home_soup, _NeverCalledSession(), headers={}))


# ---- header patch tests --------------------------------------------------


def test_header_patch_swaps_default_user_agent():
    """A fresh Client with no UA kwarg should end up on the Chrome 133 string."""
    _twikit_patches.apply()
    from twikit.client.client import Client

    client = Client()
    assert "Chrome/133" in client._user_agent
    assert "Safari/537.36" in client._user_agent


def test_header_patch_respects_user_supplied_user_agent():
    """If the caller passes user_agent= we must not clobber it."""
    _twikit_patches.apply()
    from twikit.client.client import Client

    custom = "MyCustomAgent/1.0"
    client = Client(user_agent=custom)
    assert client._user_agent == custom


def test_header_patch_adds_sec_ch_ua_headers_to_base_headers():
    """The patched _base_headers property must include the modern Sec-* set
    so Cloudflare doesn't trivially flag the request as a non-browser."""
    _twikit_patches.apply()
    from twikit.client.client import Client

    client = Client()
    headers = client._base_headers
    assert "Chrome" in headers["sec-ch-ua"]
    assert headers["sec-ch-ua-mobile"] == "?0"
    assert headers["sec-ch-ua-platform"] == '"macOS"'
    assert headers["sec-fetch-dest"] == "empty"
    assert headers["sec-fetch-mode"] == "cors"
    assert headers["sec-fetch-site"] == "same-origin"


def test_header_patch_preserves_original_required_headers():
    """The merge must not strip the auth/CSRF headers twikit relies on."""
    _twikit_patches.apply()
    from twikit.client.client import Client

    client = Client()
    headers = client._base_headers
    assert headers["content-type"] == "application/json"
    assert headers["X-Twitter-Auth-Type"] == "OAuth2Session"
    assert headers["X-Twitter-Active-User"] == "yes"
    assert headers["authorization"].startswith("Bearer ")


def test_header_patch_disabled_via_env(monkeypatch):
    """When disabled, the default UA stays on the original Safari string."""
    monkeypatch.setenv("OPENSWARM_TWITTER_DISABLE_TWIKIT_HEADER_PATCH", "1")
    _twikit_patches.apply()
    from twikit.client.client import Client

    client = Client()
    assert "Version/17.5 Safari" in client._user_agent
    assert "sec-ch-ua" not in client._base_headers
