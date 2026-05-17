"""Integration tests for the Twitter SubApp's HTTP routes.

We don't need (and won't get) a live twikit session in CI; instead we
build the SubApp's state by hand and exercise the routes via
FastAPI's TestClient. The pool's `client` field is a Mock with
AsyncMock methods, so we can drive `TooManyRequests` /
`AccountLocked` / `Unauthorized` paths deterministically.

These tests cover the load-bearing route-layer behaviors:

- The full GateResult -> HTTP status mapping (429 with retry_after_s,
  409 for locked/suspended/needs_relogin, 503 for no_account).
- DELETE wipes cookies + audit log + accounts.json.
- /health is pure-memory (no twikit call) so the test never has to
  mock anything to call it.
- Errors are not cached (a 429 followed by a success must still hit
  twikit on the second call).
"""

from __future__ import annotations

import json
import os
import tempfile
import time
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def isolated_subapp(monkeypatch):
    """Stand up the twitter SubApp's state against a temp DATA_ROOT.

    We avoid `backend.main` entirely so we don't pull in the full
    OpenSwarm app (and its 15-second startup time). Instead we mount
    the SubApp's router directly on a fresh FastAPI app.
    """
    with tempfile.TemporaryDirectory() as d:
        monkeypatch.setattr("backend.apps.twitter.persistence.TWITTER_DIR", d)
        monkeypatch.setattr(
            "backend.apps.twitter.persistence.ACCOUNTS_PATH",
            os.path.join(d, "accounts.json"),
        )
        monkeypatch.setattr(
            "backend.apps.twitter.persistence.COOKIES_DIR",
            os.path.join(d, "cookies"),
        )
        monkeypatch.setattr(
            "backend.apps.twitter.persistence.STATE_DB_PATH",
            os.path.join(d, "state.sqlite"),
        )

        # Build the SubApp's singletons inline (skip the lifespan path
        # which hydrates from disk + spawns the snapshot task).
        from backend.apps.twitter import persistence, twitter as tw
        from backend.apps.twitter.cache import TTLCache
        from backend.apps.twitter.pool import AccountPool
        from backend.apps.twitter.ratelimit import RateGate

        persistence.ensure_dirs()
        conn = persistence.open_state_db()
        tw._cache = TTLCache(conn)
        tw._pool = AccountPool(conn)
        tw._gate = RateGate(tw._pool, tw._cache, block_ceiling_s=10.0)

        app = FastAPI()
        app.include_router(tw.twitter.router, prefix="/api/twitter")
        client = TestClient(app)

        yield {
            "client": client,
            "pool": tw._pool,
            "cache": tw._cache,
            "gate": tw._gate,
            "conn": conn,
            "tmp": d,
        }

        # Reset module-level singletons so tests don't bleed state.
        tw._pool = None
        tw._gate = None
        tw._cache = None
        conn.close()


def _add_fake_account(pool, account_id="a1", state="active", handle="me"):
    """Register a Mock-backed account on the pool.

    The twikit.Client surface used by routes is async (`search_tweet`,
    `get_user_by_screen_name`, etc.), so AsyncMock is the right shape.
    `save_cookies` and `set_cookies` are sync on the real client; use
    plain MagicMock for those.
    """
    from backend.apps.twitter.models import TwitterAccount

    record = TwitterAccount(id=account_id, state=state, handle=handle, label="Test")

    client = MagicMock(name="twikit.Client")
    client.search_tweet = AsyncMock()
    client.get_user_by_screen_name = AsyncMock()
    client.get_user_by_id = AsyncMock()
    client.get_user_tweets = AsyncMock()
    client.get_tweet_by_id = AsyncMock()
    client.user = AsyncMock()
    client.save_cookies = MagicMock()

    import asyncio
    # `pool.add` is async because it acquires asyncio.Lock; spin a
    # fresh loop just for this call so we don't lean on the deprecated
    # get_event_loop() implicit-loop behavior.
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(pool.add(record, client))
    finally:
        loop.close()
    return record, client


# ---------------------------------------------------------------------------
# /accounts/{id}/health — pure-memory; no twikit calls needed
# ---------------------------------------------------------------------------

def test_health_returns_in_memory_state(isolated_subapp):
    """Health is the keep-it-cheap endpoint; should not call twikit."""
    _add_fake_account(isolated_subapp["pool"], account_id="a1")
    r = isolated_subapp["client"].get("/api/twitter/accounts/a1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "a1"
    assert body["state"] == "active"
    assert body["recent_429_count"] == 0


def test_health_missing_returns_404(isolated_subapp):
    r = isolated_subapp["client"].get("/api/twitter/accounts/missing/health")
    assert r.status_code == 404


def test_accounts_list_excludes_cookies(isolated_subapp):
    _add_fake_account(isolated_subapp["pool"])
    r = isolated_subapp["client"].get("/api/twitter/accounts")
    assert r.status_code == 200
    body = r.json()
    assert len(body["accounts"]) == 1
    # No password / cookies / sensitive fields should ever appear.
    flat = json.dumps(body)
    assert "password" not in flat.lower()
    assert "auth_token" not in flat.lower()
    assert "ct0" not in flat.lower()


# ---------------------------------------------------------------------------
# Tool reads — happy path
# ---------------------------------------------------------------------------

def _fake_tweet(tweet_id="1"):
    """Build a duck-typed tweet that survives the serializer's _safe()."""
    m = MagicMock()
    m.id = tweet_id
    m.created_at = "2024-01-01"
    m.text = "hi"
    m.lang = "en"
    m.in_reply_to = None
    m.is_quote_status = False
    m.possibly_sensitive = False
    m.view_count = 100
    m.reply_count = 0
    m.favorite_count = 0
    m.retweet_count = 0
    m.quote_count = 0
    m.bookmark_count = 0
    m.hashtags = []
    m.urls = []
    m.media = []
    m.user = None
    m.quote = None
    m.retweeted_tweet = None
    m.replies = None
    return m


def _fake_result(items):
    """Mimic twikit.utils.Result enough for `result_to_dict`."""
    r = MagicMock()
    r.__iter__ = lambda self: iter(items)
    r.next_cursor = "next-x"
    r.previous_cursor = None
    return r


def test_search_happy_path(isolated_subapp):
    _, client = _add_fake_account(isolated_subapp["pool"])
    client.search_tweet.return_value = _fake_result([_fake_tweet("1"), _fake_tweet("2")])

    r = isolated_subapp["client"].get("/api/twitter/search?q=hello&count=2")
    assert r.status_code == 200
    body = r.json()
    assert [t["id"] for t in body["items"]] == ["1", "2"]
    assert body["next_cursor"] == "next-x"


def test_search_uses_cache_on_second_call(isolated_subapp):
    _, client = _add_fake_account(isolated_subapp["pool"])
    client.search_tweet.return_value = _fake_result([_fake_tweet("1")])

    api = isolated_subapp["client"]
    api.get("/api/twitter/search?q=hello&count=2")
    api.get("/api/twitter/search?q=hello&count=2")
    assert client.search_tweet.await_count == 1, "cache hit must skip twikit"


# ---------------------------------------------------------------------------
# Error -> HTTP mapping
# ---------------------------------------------------------------------------

def test_too_many_requests_returns_429_with_retry_after_s(isolated_subapp):
    """TooManyRequests from twikit -> HTTP 429 + retry_after_s body."""
    from twikit.errors import TooManyRequests

    _, client = _add_fake_account(isolated_subapp["pool"])
    reset_at = int(time.time() + 90)
    client.search_tweet.side_effect = TooManyRequests(
        "rate limited",
        headers={"x-rate-limit-reset": str(reset_at)},
    )

    r = isolated_subapp["client"].get("/api/twitter/search?q=hi")
    assert r.status_code == 429
    body = r.json()
    assert "retry_after_s" in body
    # Should be in the ballpark of 90 (server told us ~90s).
    assert 80 <= body["retry_after_s"] <= 100


def test_429_is_not_cached(isolated_subapp):
    """Errors must never end up memoized.

    Sequence: first call -> 429; bucket clears; second call -> success.
    If the cache held the 429, the second call would also 429.
    """
    from twikit.errors import TooManyRequests

    _, client = _add_fake_account(isolated_subapp["pool"])
    client.search_tweet.side_effect = [
        TooManyRequests("rate limited", headers={"x-rate-limit-reset": str(int(time.time() + 1))}),
        _fake_result([_fake_tweet("1")]),
    ]

    api = isolated_subapp["client"]
    r1 = api.get("/api/twitter/search?q=cached-test")
    assert r1.status_code == 429

    # Clear the bucket lock so the second call can go through.
    pool = isolated_subapp["pool"]
    pool.get("a1").bucket("search_tweet").locked_until = 0.0
    pool.get("a1").bucket("search_tweet").tokens = 5.0

    r2 = api.get("/api/twitter/search?q=cached-test")
    assert r2.status_code == 200
    # Both calls must hit twikit — the 429 didn't poison the cache.
    assert client.search_tweet.await_count == 2


def test_account_locked_returns_409(isolated_subapp):
    from twikit.errors import AccountLocked

    _, client = _add_fake_account(isolated_subapp["pool"])
    client.search_tweet.side_effect = AccountLocked("arkose")
    r = isolated_subapp["client"].get("/api/twitter/search?q=x")
    assert r.status_code == 409
    # Pool state should reflect.
    assert isolated_subapp["pool"].get("a1").state == "locked"


def test_unauthorized_returns_409_and_marks_needs_relogin(isolated_subapp):
    from twikit.errors import Unauthorized

    _, client = _add_fake_account(isolated_subapp["pool"])
    client.search_tweet.side_effect = Unauthorized("expired")
    r = isolated_subapp["client"].get("/api/twitter/search?q=x")
    assert r.status_code == 409
    assert isolated_subapp["pool"].get("a1").state == "needs_relogin"


def test_no_account_returns_503(isolated_subapp):
    """No accounts in the pool -> 503 (we don't have anyone to ask)."""
    r = isolated_subapp["client"].get("/api/twitter/search?q=x")
    assert r.status_code == 503


def test_inactive_account_treated_as_no_account(isolated_subapp):
    _, _client = _add_fake_account(isolated_subapp["pool"], state="locked")
    r = isolated_subapp["client"].get("/api/twitter/search?q=x")
    # pick() returns None because no active accounts -> 503.
    assert r.status_code == 503


# ---------------------------------------------------------------------------
# /user — handle vs id
# ---------------------------------------------------------------------------

def test_get_user_by_handle(isolated_subapp):
    _, client = _add_fake_account(isolated_subapp["pool"])
    fake_user = MagicMock()
    fake_user.id = "999"
    fake_user.screen_name = "openai"
    fake_user.name = "OpenAI"
    fake_user.description = ""
    fake_user.location = ""
    fake_user.url = ""
    fake_user.profile_image_url = ""
    fake_user.profile_banner_url = ""
    fake_user.created_at = ""
    fake_user.is_blue_verified = False
    fake_user.verified = False
    fake_user.followers_count = 1
    fake_user.following_count = 2
    fake_user.statuses_count = 3
    fake_user.media_count = 4
    fake_user.listed_count = 5
    fake_user.favourites_count = 6
    fake_user.pinned_tweet_ids = []
    client.get_user_by_screen_name.return_value = fake_user

    r = isolated_subapp["client"].get("/api/twitter/user?handle=openai")
    assert r.status_code == 200
    assert r.json()["handle"] == "openai"


def test_get_user_requires_exactly_one_arg(isolated_subapp):
    api = isolated_subapp["client"]
    assert api.get("/api/twitter/user").status_code == 400
    assert api.get("/api/twitter/user?handle=a&id=b").status_code == 400


# ---------------------------------------------------------------------------
# PATCH /accounts/{id} — trust_multiplier
# ---------------------------------------------------------------------------

def test_patch_trust_multiplier_rescales_buckets(isolated_subapp):
    _add_fake_account(isolated_subapp["pool"])
    # Force-create the search_tweet bucket so the rescale has something to do.
    isolated_subapp["pool"].get("a1").bucket("search_tweet")

    api = isolated_subapp["client"]
    r = api.patch("/api/twitter/accounts/a1", json={"trust_multiplier": 0.2})
    assert r.status_code == 200
    pool = isolated_subapp["pool"]
    b = pool.get("a1").bucket("search_tweet")
    # 50 * 0.2 = 10.
    assert b.capacity == 10


def test_patch_trust_multiplier_zero_pauses_account(isolated_subapp):
    """trust_multiplier=0 is allowed and zeros the bucket capacity.

    Operators reach for this when an account starts misbehaving and they
    want to leave it in the pool (cookies, audit history) without it
    being picked. Bucket.time_until_available() returns a long sentinel
    in that state so pick() naturally deprioritizes it.
    """
    _add_fake_account(isolated_subapp["pool"])
    isolated_subapp["pool"].get("a1").bucket("search_tweet")

    api = isolated_subapp["client"]
    r = api.patch("/api/twitter/accounts/a1", json={"trust_multiplier": 0.0})
    assert r.status_code == 200
    b = isolated_subapp["pool"].get("a1").bucket("search_tweet")
    assert b.capacity == 0


def test_patch_trust_multiplier_validates_range(isolated_subapp):
    _add_fake_account(isolated_subapp["pool"])
    api = isolated_subapp["client"]
    assert api.patch("/api/twitter/accounts/a1", json={"trust_multiplier": 1.5}).status_code == 422
    assert api.patch("/api/twitter/accounts/a1", json={"trust_multiplier": -0.1}).status_code == 422


# ---------------------------------------------------------------------------
# DELETE — wipes everything
# ---------------------------------------------------------------------------

def test_delete_wipes_cookies_and_buckets(isolated_subapp):
    from backend.apps.twitter import persistence as pers

    _add_fake_account(isolated_subapp["pool"])
    # Drop a fake cookies file so DELETE has something to wipe.
    cpath = pers.cookies_path("a1")
    with open(cpath, "w") as f:
        f.write("{}")

    # Touch a bucket + snapshot so we have a row to clean up.
    pool = isolated_subapp["pool"]
    pool.get("a1").bucket("search_tweet")
    pool.snapshot_all()

    api = isolated_subapp["client"]
    r = api.delete("/api/twitter/accounts/a1")
    assert r.status_code == 200
    assert pool.get("a1") is None
    assert not os.path.exists(cpath)
    (n,) = isolated_subapp["conn"].execute(
        "SELECT COUNT(*) FROM twitter_buckets WHERE account_id='a1'"
    ).fetchone()
    assert n == 0


def test_delete_missing_account_is_noop(isolated_subapp):
    r = isolated_subapp["client"].delete("/api/twitter/accounts/never-existed")
    assert r.status_code == 200
    assert r.json()["removed"] is True


# ---------------------------------------------------------------------------
# POST /accounts/import — cookie import from the Electron webview flow
# ---------------------------------------------------------------------------
#
# The route is the HTTP sibling of `import_cookies.py`: it accepts the
# raw `auth_token` + `ct0` pair the popup BrowserWindow scrapes from
# x.com's session and plugs them into the live pool. These tests use a
# Mock twikit.Client so we never actually hit x.com — same shape as the
# `_add_fake_account` helper above, just plumbed in via the route's
# `from twikit import Client` import.

@pytest.fixture
def patched_twikit_client(monkeypatch):
    """Replace `twikit.Client` with a Mock factory.

    The route under test does `from twikit import Client; client =
    Client(...)`. We patch the attribute on the twikit module so the
    route receives a Mock whose `set_cookies` is a no-op and whose
    async `user()` returns a duck-typed user. Per-test customization
    is via the returned `make` factory (e.g. swap `user.side_effect`
    to drive the verify-failure path).
    """
    from unittest.mock import MagicMock, AsyncMock

    state = {"clients": []}

    def make(*_a, **_kw):
        c = MagicMock(name="twikit.Client")
        c.set_cookies = MagicMock()
        c.save_cookies = MagicMock()
        fake_user = MagicMock()
        fake_user.screen_name = "imported_user"
        c.user = AsyncMock(return_value=fake_user)
        state["clients"].append(c)
        return c

    import twikit
    monkeypatch.setattr(twikit, "Client", make)
    return state


def test_import_creates_new_account(isolated_subapp, patched_twikit_client):
    """Happy path: fresh import lands one account in the pool + on disk."""
    from backend.apps.twitter import persistence as pers

    api = isolated_subapp["client"]
    r = api.post(
        "/api/twitter/accounts/import",
        json={"auth_token": "a" * 40, "ct0": "c" * 32, "label": "personal"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    account = body["account"]
    assert account["state"] == "active"
    assert account["label"] == "personal"
    # /verify (run inline) stamped the handle from the mocked client.user().
    assert account["handle"] == "imported_user"

    # Cookies landed on disk with the right mode.
    cookie_path = pers.cookies_path(account["id"])
    assert os.path.exists(cookie_path)
    mode = os.stat(cookie_path).st_mode & 0o777
    assert mode == 0o600, f"cookies file should be 0o600, got {oct(mode)}"
    with open(cookie_path) as f:
        on_disk = json.load(f)
    assert on_disk == {"auth_token": "a" * 40, "ct0": "c" * 32}

    # Pool got exactly one entry.
    pool = isolated_subapp["pool"]
    assert len(pool.accounts) == 1
    assert pool.get(account["id"]) is not None


def test_import_idempotent_relogin_by_id(isolated_subapp, patched_twikit_client):
    """Re-importing with the same id refreshes cookies in place.

    This is the "my session expired, sign me in again" path. The
    pool should still hold one account and the on-disk cookies
    should reflect the latest tokens.
    """
    from backend.apps.twitter import persistence as pers

    api = isolated_subapp["client"]
    r1 = api.post(
        "/api/twitter/accounts/import",
        json={"auth_token": "old" + "x" * 40, "ct0": "ct0-old" + "y" * 32},
    )
    assert r1.status_code == 200
    aid = r1.json()["account"]["id"]
    first_verified = r1.json()["account"]["last_verified_at"]

    # Sleep a hair so last_verified_at advances.
    time.sleep(0.01)
    r2 = api.post(
        "/api/twitter/accounts/import",
        json={"auth_token": "new" + "x" * 40, "ct0": "ct0-new" + "y" * 32, "id": aid},
    )
    assert r2.status_code == 200
    body = r2.json()
    assert body["account"]["id"] == aid
    assert body["account"]["last_verified_at"] >= first_verified

    # Pool size unchanged.
    assert len(isolated_subapp["pool"].accounts) == 1

    # On-disk cookies are the *new* values, not the old ones.
    with open(pers.cookies_path(aid)) as f:
        on_disk = json.load(f)
    assert on_disk["auth_token"].startswith("new")
    assert on_disk["ct0"].startswith("ct0-new")


def test_import_by_handle_dedupes(isolated_subapp, patched_twikit_client):
    """Pre-existing account with the same handle is re-used.

    The UI passes `handle` when refreshing a session for a known
    account whose id it doesn't have on hand. The pool's
    `by_handle()` lookup is what backs the dedupe.
    """
    _, _client = _add_fake_account(isolated_subapp["pool"], account_id="seed-1", handle="alice")
    pool = isolated_subapp["pool"]
    assert len(pool.accounts) == 1

    api = isolated_subapp["client"]
    r = api.post(
        "/api/twitter/accounts/import",
        json={"auth_token": "a" * 40, "ct0": "c" * 32, "handle": "alice"},
    )
    assert r.status_code == 200
    body = r.json()
    # Same id as the seed account — by_handle matched.
    assert body["account"]["id"] == "seed-1"
    # Pool stays at one account; we didn't create a duplicate.
    assert len(pool.accounts) == 1


def test_import_rejects_empty_tokens(isolated_subapp, patched_twikit_client):
    """Either field empty (after strip) is a 422.

    Belt-and-suspenders: the model has `min_length=1` AND a validator
    that strips. Both empty inputs and whitespace-only inputs should
    fail before we touch the pool.
    """
    api = isolated_subapp["client"]
    assert api.post("/api/twitter/accounts/import", json={"auth_token": "", "ct0": "x"}).status_code == 422
    assert api.post("/api/twitter/accounts/import", json={"auth_token": "x", "ct0": ""}).status_code == 422
    assert api.post("/api/twitter/accounts/import", json={"auth_token": "   ", "ct0": "x" * 40}).status_code == 422
    # Pool stays empty.
    assert len(isolated_subapp["pool"].accounts) == 0


def test_import_response_excludes_cookies(isolated_subapp, patched_twikit_client):
    """The response must never echo the cookies back.

    Mirrors `test_accounts_list_excludes_cookies` — the same contract
    applies to import. The frontend has the tokens already; sending
    them back over the wire just widens the surface area for a leak.
    """
    api = isolated_subapp["client"]
    r = api.post(
        "/api/twitter/accounts/import",
        json={"auth_token": "secret-auth-token-value-aaaaa", "ct0": "secret-ct0-value-bbbbb"},
    )
    assert r.status_code == 200
    flat = json.dumps(r.json())
    assert "secret-auth-token-value-aaaaa" not in flat
    assert "secret-ct0-value-bbbbb" not in flat
    assert "auth_token" not in flat
    assert "\"ct0\"" not in flat


def test_import_verify_failure_marks_needs_relogin(isolated_subapp, patched_twikit_client):
    """A stale/forged cookie pair still imports, but state degrades.

    We force the verify call (`client.user()`) to raise Unauthorized.
    `_verify_account` catches it and flips the account to
    `needs_relogin`. The route still returns 200 — we want the UI to
    surface the degraded state, not eat a 4xx for what was a
    successful import-followed-by-failed-verify.
    """
    from unittest.mock import AsyncMock
    from twikit.errors import Unauthorized

    # Replace the factory so any new Client raises Unauthorized on .user().
    import twikit

    def make_failing(*_a, **_kw):
        from unittest.mock import MagicMock
        c = MagicMock(name="twikit.Client")
        c.set_cookies = MagicMock()
        c.save_cookies = MagicMock()
        c.user = AsyncMock(side_effect=Unauthorized("expired session"))
        return c

    twikit.Client = make_failing  # patched_twikit_client fixture already monkeypatched; this just overrides

    api = isolated_subapp["client"]
    r = api.post(
        "/api/twitter/accounts/import",
        json={"auth_token": "a" * 40, "ct0": "c" * 32},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is False
    assert body["account"]["state"] == "needs_relogin"
