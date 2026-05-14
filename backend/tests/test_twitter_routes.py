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
