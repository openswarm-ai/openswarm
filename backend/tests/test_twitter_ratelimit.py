"""Unit tests for the Twitter SubApp's rate-limit and cache primitives.

No live twikit calls — `RateGate` is exercised via fake `pool` / `cache`
stand-ins so we can deterministically drive each error branch and assert
the resulting `GateResult.outcome`.

Why these exist:
- Bucket math is load-bearing for the whole system; a refill bug ships
  as "user gets locked out of X."
- The `min(saved, capacity/2)` restore rule is a correctness invariant
  for crash safety; future refactors must not regress it.
- Errors-not-cached is a security/correctness rule (don't memoize a
  rate-limit-storm as the canonical answer).
"""

from __future__ import annotations

import asyncio
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any

import pytest


# ---------------------------------------------------------------------------
# Bucket
# ---------------------------------------------------------------------------

def test_bucket_starts_full():
    from backend.apps.twitter.ratelimit import Bucket

    b = Bucket(capacity=10)
    assert b.tokens == pytest.approx(10.0)
    assert b.time_until_available() == 0.0


def test_bucket_refills_proportionally(monkeypatch):
    """1 minute elapsed -> 1/15 of capacity refilled."""
    from backend.apps.twitter.ratelimit import Bucket

    b = Bucket(capacity=150)
    b.tokens = 0.0
    fake_now = 1000.0
    monkeypatch.setattr("backend.apps.twitter.ratelimit.time.monotonic", lambda: fake_now)
    b.last_refill = fake_now
    fake_now = 1000.0 + 60.0  # 1 minute later
    # Expected refill: 150 * (60 / 900) = 10 tokens.
    b._refill()
    assert b.tokens == pytest.approx(10.0, abs=0.01)


def test_bucket_acquire_returns_when_token_available():
    from backend.apps.twitter.ratelimit import Bucket

    async def _run():
        b = Bucket(capacity=5)
        before = b.tokens
        await b.acquire()
        assert b.tokens == pytest.approx(before - 1.0)

    asyncio.run(_run())


def test_bucket_time_until_available_respects_locked_until(monkeypatch):
    """Even with tokens available, locked_until in the future should win."""
    from backend.apps.twitter.ratelimit import Bucket

    b = Bucket(capacity=10)
    assert b.tokens >= 1.0
    fake_wall = 5000.0
    monkeypatch.setattr("backend.apps.twitter.ratelimit.time.time", lambda: fake_wall)
    b.locked_until = fake_wall + 30.0
    wait = b.time_until_available()
    assert wait == pytest.approx(30.0, abs=0.5)


def test_bucket_locked_until_in_past_is_noop(monkeypatch):
    from backend.apps.twitter.ratelimit import Bucket

    b = Bucket(capacity=10)
    fake_wall = 5000.0
    monkeypatch.setattr("backend.apps.twitter.ratelimit.time.time", lambda: fake_wall)
    b.locked_until = fake_wall - 10.0  # past
    assert b.time_until_available() == 0.0


def test_bucket_mark_rate_limited_zeros_tokens_and_locks(monkeypatch):
    from backend.apps.twitter.ratelimit import Bucket

    b = Bucket(capacity=10)
    fake_wall = 5000.0
    monkeypatch.setattr("backend.apps.twitter.ratelimit.time.time", lambda: fake_wall)
    b.mark_rate_limited(reset_at=fake_wall + 60.0)
    assert b.tokens == 0.0
    # locked_until = reset + 1-5s jitter, so 61.0 <= locked_until - now <= 65.0.
    assert fake_wall + 61.0 <= b.locked_until <= fake_wall + 65.0


def test_bucket_mark_rate_limited_no_reset_falls_back_to_full_window(monkeypatch):
    """If twikit didn't surface a reset header, cool down for one window."""
    from backend.apps.twitter.ratelimit import Bucket, WINDOW_S

    b = Bucket(capacity=10)
    fake_wall = 5000.0
    monkeypatch.setattr("backend.apps.twitter.ratelimit.time.time", lambda: fake_wall)
    b.mark_rate_limited(reset_at=None)
    # locked_until ~ now + WINDOW_S + jitter
    assert fake_wall + WINDOW_S + 1.0 <= b.locked_until <= fake_wall + WINDOW_S + 5.0


def test_bucket_snapshot_restore_round_trip(monkeypatch):
    """Snapshot then restore preserves locked_until and caps tokens at capacity/2."""
    from backend.apps.twitter.ratelimit import Bucket

    fake_wall = 5000.0
    monkeypatch.setattr("backend.apps.twitter.ratelimit.time.time", lambda: fake_wall)
    monkeypatch.setattr("backend.apps.twitter.ratelimit.time.monotonic", lambda: 7000.0)

    b = Bucket(capacity=100)
    b.tokens = 80.0
    b.locked_until = fake_wall + 42.0

    snap = b.snapshot()
    assert snap["locked_until"] == pytest.approx(fake_wall + 42.0)

    restored = Bucket.restore(snap)
    # tokens were 80 but capacity/2 is 50, so restore should clamp to 50.
    assert restored.tokens == pytest.approx(50.0)
    assert restored.locked_until == pytest.approx(fake_wall + 42.0)
    assert restored.capacity == 100


def test_bucket_restore_with_low_saved_tokens(monkeypatch):
    """If saved tokens < capacity/2, keep the saved value (don't inflate)."""
    from backend.apps.twitter.ratelimit import Bucket

    monkeypatch.setattr("backend.apps.twitter.ratelimit.time.monotonic", lambda: 1.0)
    restored = Bucket.restore({"capacity": 100, "tokens": 5.0, "locked_until": 0.0})
    assert restored.tokens == pytest.approx(5.0)


def test_bucket_capacity_zero_does_not_divide_by_zero():
    """Paused account (trust_multiplier=0) → capacity=0 in the bucket math.

    Used to crash with ZeroDivisionError in time_until_available because
    the refill rate is capacity/WINDOW_S. We now treat capacity=0 as
    "infinite wait" with a 24h sentinel so pick() naturally deprioritizes
    paused accounts.
    """
    from backend.apps.twitter.ratelimit import Bucket

    b = Bucket(capacity=0)
    # Should not raise.
    wait = b.time_until_available()
    # Sentinel is large enough that any other account beats it in pick().
    assert wait >= 3600.0


def test_bucket_capacity_zero_round_trips_through_snapshot(monkeypatch):
    """Restoring a snapshot with capacity=0 keeps it at 0 (not floored to 1)."""
    from backend.apps.twitter.ratelimit import Bucket

    monkeypatch.setattr("backend.apps.twitter.ratelimit.time.monotonic", lambda: 1.0)
    restored = Bucket.restore({"capacity": 0, "tokens": 0.0, "locked_until": 0.0})
    assert restored.capacity == 0


# ---------------------------------------------------------------------------
# TTLCache
# ---------------------------------------------------------------------------

@pytest.fixture
def cache_conn():
    """In-memory sqlite with the cache schema; isolated per test."""
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE twitter_cache (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            expires_at REAL NOT NULL
        )
        """
    )
    conn.commit()
    return conn


def test_cache_get_miss_returns_none(cache_conn):
    from backend.apps.twitter.cache import TTLCache

    c = TTLCache(cache_conn)
    assert c.get(("x",)) is None


def test_cache_set_then_get(cache_conn):
    from backend.apps.twitter.cache import TTLCache

    c = TTLCache(cache_conn)
    c.set(("user", "openai"), {"id": "123"}, ttl=60)
    assert c.get(("user", "openai")) == {"id": "123"}


def test_cache_expiry(cache_conn):
    """An entry with a past expiry should miss and be evicted from memory."""
    from backend.apps.twitter.cache import TTLCache

    c = TTLCache(cache_conn)
    c.set(("x",), 1, ttl=60)
    # Force expiry by rewriting the in-memory entry.
    c._mem[c._mem and list(c._mem.keys())[0]] = (time.time() - 1, 1)
    assert c.get(("x",)) is None


def test_cache_warm_from_disk_drops_expired(cache_conn):
    from backend.apps.twitter.cache import TTLCache, _normalize_key

    # Pre-populate with one fresh, one stale entry.
    cache_conn.execute(
        "INSERT INTO twitter_cache (key, value_json, expires_at) VALUES (?, ?, ?)",
        (_normalize_key(("fresh",)), '{"a": 1}', time.time() + 60),
    )
    cache_conn.execute(
        "INSERT INTO twitter_cache (key, value_json, expires_at) VALUES (?, ?, ?)",
        (_normalize_key(("stale",)), '{"a": 2}', time.time() - 60),
    )
    cache_conn.commit()

    c = TTLCache(cache_conn)
    assert c.get(("fresh",)) == {"a": 1}
    assert c.get(("stale",)) is None
    # The stale row should have been deleted from disk on warm-up.
    n = cache_conn.execute("SELECT COUNT(*) FROM twitter_cache").fetchone()[0]
    assert n == 1


def test_cache_invalidate(cache_conn):
    from backend.apps.twitter.cache import TTLCache

    c = TTLCache(cache_conn)
    c.set(("x",), 42, ttl=60)
    c.invalidate(("x",))
    assert c.get(("x",)) is None


# ---------------------------------------------------------------------------
# RateGate
# ---------------------------------------------------------------------------

@dataclass
class _FakeAccount:
    id: str = "acct1"
    client: object = field(default_factory=lambda: object())
    concurrency: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(1))
    _buckets: dict = field(default_factory=dict)

    def bucket(self, endpoint: str):
        from backend.apps.twitter.ratelimit import Bucket, DEFAULT_BUDGETS
        if endpoint not in self._buckets:
            self._buckets[endpoint] = Bucket(capacity=DEFAULT_BUDGETS.get(endpoint, 10))
        return self._buckets[endpoint]


@dataclass
class _FakePool:
    """Minimal AccountPool stand-in for gate tests.

    Tracks side-effects (mark_locked / mark_suspended / etc.) as flags
    so tests can assert the gate routed each twikit error correctly.
    """

    account: _FakeAccount | None = field(default_factory=_FakeAccount)
    locked: list[str] = field(default_factory=list)
    suspended: list[str] = field(default_factory=list)
    relogin: list[str] = field(default_factory=list)
    rate_limited_log: list[tuple[str, str]] = field(default_factory=list)

    async def pick(self, endpoint: str):
        return self.account

    def record_429(self, acct_id: str, endpoint: str) -> None:
        self.rate_limited_log.append((acct_id, endpoint))

    def mark_locked(self, acct_id: str, reason: str) -> None:
        self.locked.append(acct_id)

    def mark_suspended(self, acct_id: str, reason: str) -> None:
        self.suspended.append(acct_id)

    def mark_needs_relogin(self, acct_id: str, reason: str) -> None:
        self.relogin.append(acct_id)


class _FakeCache:
    """In-memory cache with .get/.set shape compatible with TTLCache."""
    def __init__(self) -> None:
        self.store: dict[tuple, Any] = {}

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value, *, ttl):
        self.store[key] = value


def test_gate_cache_hit_short_circuits_bucket():
    """A cache hit should never touch pool.pick or twikit."""
    from backend.apps.twitter.ratelimit import RateGate

    cache = _FakeCache()
    cache.store[("k",)] = {"hit": True}
    pool = _FakePool(account=None)  # would explode if asked
    gate = RateGate(pool, cache)

    async def op(_client):
        raise AssertionError("op must not be called on cache hit")

    async def _run():
        return await gate.execute(
            endpoint="search_tweet",
            op=op,
            serializer=lambda x: x,
            cache_key=("k",),
            cache_ttl=60,
        )

    result = asyncio.run(_run())
    assert result.outcome == "ok"
    assert result.value == {"hit": True}


def test_gate_no_account_returns_no_account():
    from backend.apps.twitter.ratelimit import RateGate

    pool = _FakePool(account=None)
    gate = RateGate(pool, _FakeCache())

    async def op(_client):
        return None

    async def _run():
        return await gate.execute(
            endpoint="search_tweet",
            op=op,
            serializer=lambda x: x,
        )

    result = asyncio.run(_run())
    assert result.outcome == "no_account"


def test_gate_returns_rate_limited_when_wait_exceeds_ceiling(monkeypatch):
    """If the bucket says we'd wait > block_ceiling_s, return 429 instead of blocking."""
    from backend.apps.twitter.ratelimit import RateGate

    pool = _FakePool()
    gate = RateGate(pool, _FakeCache(), block_ceiling_s=5.0)
    # Force the search bucket to be locked far in the future.
    bucket = pool.account.bucket("search_tweet")
    fake_wall = 1000.0
    monkeypatch.setattr("backend.apps.twitter.ratelimit.time.time", lambda: fake_wall)
    bucket.locked_until = fake_wall + 120.0
    bucket.tokens = 0.0

    async def op(_client):
        raise AssertionError("op must not be called when ceiling exceeded")

    async def _run():
        return await gate.execute(
            endpoint="search_tweet",
            op=op,
            serializer=lambda x: x,
        )

    result = asyncio.run(_run())
    assert result.outcome == "rate_limited"
    assert result.value["retry_after_s"] >= 120


def test_gate_ok_path_calls_serializer_and_caches():
    from backend.apps.twitter.ratelimit import RateGate

    pool = _FakePool()
    cache = _FakeCache()
    gate = RateGate(pool, cache)

    async def op(_client):
        return "raw"

    async def _run():
        return await gate.execute(
            endpoint="search_tweet",
            op=op,
            serializer=lambda x: {"serialized": x},
            cache_key=("k",),
            cache_ttl=60,
        )

    result = asyncio.run(_run())
    assert result.outcome == "ok"
    assert result.value == {"serialized": "raw"}
    assert cache.store == {("k",): {"serialized": "raw"}}


def test_gate_does_not_cache_errors():
    """Error outcomes must not leave anything in the cache."""
    from backend.apps.twitter.ratelimit import RateGate
    from twikit.errors import TooManyRequests

    pool = _FakePool()
    cache = _FakeCache()
    gate = RateGate(pool, cache)

    err = TooManyRequests("rate limited", headers={"x-rate-limit-reset": str(int(time.time() + 30))})

    async def op(_client):
        raise err

    async def _run():
        return await gate.execute(
            endpoint="search_tweet",
            op=op,
            serializer=lambda x: x,
            cache_key=("k",),
            cache_ttl=60,
        )

    result = asyncio.run(_run())
    assert result.outcome == "rate_limited"
    assert cache.store == {}, "errors must never end up in the cache"
    assert pool.rate_limited_log == [("acct1", "search_tweet")]


def test_gate_account_locked_routes_to_locked_outcome():
    from backend.apps.twitter.ratelimit import RateGate
    from twikit.errors import AccountLocked

    pool = _FakePool()
    gate = RateGate(pool, _FakeCache())

    async def op(_client):
        raise AccountLocked("arkose")

    async def _run():
        return await gate.execute(
            endpoint="search_tweet",
            op=op,
            serializer=lambda x: x,
        )

    result = asyncio.run(_run())
    assert result.outcome == "locked"
    assert pool.locked == ["acct1"]


def test_gate_account_suspended_routes_to_suspended_outcome():
    from backend.apps.twitter.ratelimit import RateGate
    from twikit.errors import AccountSuspended

    pool = _FakePool()
    gate = RateGate(pool, _FakeCache())

    async def op(_client):
        raise AccountSuspended("suspended")

    async def _run():
        return await gate.execute(
            endpoint="search_tweet",
            op=op,
            serializer=lambda x: x,
        )

    assert asyncio.run(_run()).outcome == "suspended"
    assert pool.suspended == ["acct1"]


def test_gate_unauthorized_routes_to_needs_relogin():
    from backend.apps.twitter.ratelimit import RateGate
    from twikit.errors import Unauthorized

    pool = _FakePool()
    gate = RateGate(pool, _FakeCache())

    async def op(_client):
        raise Unauthorized("expired cookies")

    async def _run():
        return await gate.execute(
            endpoint="search_tweet",
            op=op,
            serializer=lambda x: x,
        )

    assert asyncio.run(_run()).outcome == "needs_relogin"
    assert pool.relogin == ["acct1"]
