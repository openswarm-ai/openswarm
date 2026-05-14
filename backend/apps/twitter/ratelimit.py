"""Token-bucket rate limiter for twikit calls.

Twitter's internal GraphQL API rate-limits per-(account, endpoint) in a
rolling 15-minute window. Twikit doesn't track this proactively — it just
raises `twikit.errors.TooManyRequests` after the fact, with the server's
`x-rate-limit-reset` epoch parsed into `exc.rate_limit_reset`. That's
fine as a safety net, but for a multi-agent setup we want to *avoid*
ever hitting 429 in the first place: every 429 is a heuristic flag on
the user's account, and accumulating them is how accounts get locked.

This module provides:

- `Bucket` — a token bucket that refills continuously over a 15-min
  window, with an extra `locked_until` field driven reactively by 429
  responses (when X tells us the bucket reset time, we trust the server
  over our local accounting).
- `DEFAULT_BUDGETS` — community-observed per-endpoint ceilings. The
  effective per-bucket capacity is `DEFAULT_BUDGETS[endpoint] *
  account.trust_multiplier`, where the multiplier defaults to 0.4 for
  primary accounts (keep way clear of the heuristic threshold) and is a
  writable field the operator can ratchet up after observing no 429s.
- `RateGate` — orchestrator that combines a `TTLCache`, an `AccountPool`,
  and per-bucket `acquire()` into a single async call that either returns
  the serialized result, returns a structured "rate_limited" with
  `retry_after_s`, or surfaces an error category for the route to handle.

Concurrency: every code path that mutates `tokens` / `locked_until` runs
on the asyncio event loop, single-threaded, never awaits between a read
and a write. No lock needed.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Literal, TypeVar

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Community-observed per-endpoint ceilings (calls per 15-minute window).
# Treat these as upper bounds; the effective cap is multiplied by the
# account's `trust_multiplier` (default 0.4 for primary).
#
# Source: community measurements on twscrape / twikit repos; X doesn't
# publish these. They're approximate and drift over time. The lifespan's
# smoke probe logs loudly if any single endpoint trips a 429 within the
# first hour after startup — that's the signal to bump caps down.
DEFAULT_BUDGETS: dict[str, int] = {
    "search_tweet": 50,
    "get_user_by_screen_name": 95,
    "get_user_by_id": 95,
    "get_user_tweets": 50,
    "get_tweet_by_id": 150,   # also covers tweet replies (same endpoint)
    # Internal/admin endpoints. /verify and the startup smoke probe
    # share this bucket. We used to set this to 10, which at
    # trust_multiplier=0.4 left only 4 tokens/15min — meaning a single
    # dev hot-reload cycle ate 25% of the verify window. X doesn't
    # appear to rate-limit `client.user()` tightly so a roomier budget
    # is safe.
    "_self_user": 100,
}

WINDOW_S: float = 15 * 60.0


@dataclass
class Bucket:
    """Continuous-refill token bucket for one (account, endpoint) pair.

    - `capacity` is the cap **after** trust_multiplier scaling. Callers
      pass the already-scaled value; this class doesn't know about
      multipliers.
    - `tokens` is a float in `[0, capacity]`. It refills at
      `capacity / WINDOW_S` per second. Restoring from a snapshot starts
      lower (see persistence) to make crash-burst impossible.
    - `locked_until` is a wall-clock UNIX timestamp set when twikit
      raises `TooManyRequests`. While `now < locked_until`, no calls
      go through regardless of `tokens` — we trust the server's reset
      hint over our local clock.
    """

    capacity: int
    tokens: float = field(init=False)
    last_refill: float = field(default_factory=time.monotonic)
    locked_until: float = 0.0

    def __post_init__(self) -> None:
        self.tokens = float(self.capacity)

    def _refill(self) -> None:
        """Add tokens proportional to elapsed monotonic time."""
        now = time.monotonic()
        elapsed = now - self.last_refill
        if elapsed <= 0:
            return
        if self.capacity <= 0:
            # Paused bucket. No refill, no division — just mark time
            # and return so future calls don't compute against stale
            # last_refill.
            self.last_refill = now
            return
        rate = self.capacity / WINDOW_S
        self.tokens = min(float(self.capacity), self.tokens + elapsed * rate)
        self.last_refill = now

    def time_until_available(self) -> float:
        """Seconds the caller would block in `acquire()` right now.

        Returns 0.0 if a call could go through immediately. Useful for
        the route layer to decide between blocking (short wait) and
        returning a 429 with `retry_after_s` (long wait).

        A capacity of 0 means the operator has paused this account
        (trust_multiplier=0). The bucket never refills past zero, so
        we return a long-but-finite sentinel: pick() ranks by this
        value, so any other account will outrank a paused one.
        """
        self._refill()
        wall_wait = max(0.0, self.locked_until - time.time())
        token_wait = 0.0
        if self.tokens < 1.0:
            if self.capacity <= 0:
                # 24 hours — far above any block_ceiling_s we'd set,
                # so RateGate will return rate_limited rather than
                # waiting. No division by zero.
                token_wait = 86400.0
            else:
                deficit = 1.0 - self.tokens
                token_wait = deficit * WINDOW_S / self.capacity
        return max(token_wait, wall_wait)

    async def acquire(self) -> None:
        """Block until one token is available, then consume it.

        Loops in case multiple coroutines race the same bucket — each
        wakes from sleep, re-checks `time_until_available`, and decides
        to sleep again or take the token. The +50–250ms jitter prevents
        synchronized thundering-herd patterns that look bot-like to X.
        """
        while True:
            wait = self.time_until_available()
            if wait <= 0:
                self.tokens = max(0.0, self.tokens - 1.0)
                return
            await asyncio.sleep(wait + random.uniform(0.05, 0.25))

    def mark_rate_limited(self, reset_at: float | None) -> None:
        """React to a 429 from twikit by trusting the server's reset.

        `reset_at` is an absolute UNIX timestamp (the contents of
        `x-rate-limit-reset`). We add a few seconds of jitter to keep
        post-cooldown traffic from hitting the wall in lockstep with
        other clients on the same account.
        """
        now = time.time()
        if reset_at is None or reset_at <= now:
            # Server didn't tell us a reset time (or it's in the past).
            # Cool down for one full window to be safe.
            reset_at = now + WINDOW_S
        self.locked_until = reset_at + random.uniform(1.0, 5.0)
        self.tokens = 0.0

    def snapshot(self) -> dict:
        """Serializable representation for persistence."""
        self._refill()
        return {
            "capacity": self.capacity,
            "tokens": self.tokens,
            "locked_until": self.locked_until,
        }

    @classmethod
    def restore(cls, snap: dict) -> "Bucket":
        """Reconstruct from `snapshot()` with crash-safe headroom.

        On startup we deliberately restore `tokens` at `min(saved,
        capacity / 2)` so an unclean shutdown (where the last 1s of
        decrements weren't snapshotted) can't lead to a post-restart
        burst. Costs at most half a window's headroom in exchange for
        a hard guarantee against accidental 429-storms.

        Capacity 0 (paused account) round-trips intact.
        """
        capacity = max(0, int(snap.get("capacity", 1)))
        b = cls(capacity=capacity)
        saved_tokens = float(snap.get("tokens", capacity))
        b.tokens = max(0.0, min(saved_tokens, capacity / 2.0))
        b.locked_until = float(snap.get("locked_until", 0.0))
        b.last_refill = time.monotonic()
        return b


# RateGate result categories. The route layer dispatches on this rather
# than catching exceptions for control flow.
GateOutcome = Literal["ok", "rate_limited", "locked", "needs_relogin", "suspended", "no_account", "error"]


@dataclass
class GateResult:
    outcome: GateOutcome
    value: object = None      # ok: serialized payload; rate_limited: {retry_after_s}; error: error message
    account_id: str | None = None


class RateGate:
    """Per-request orchestration: cache -> pool -> bucket -> twikit.

    The class is deliberately tiny — it owns no state of its own beyond
    references to the pool and the cache, so a route handler can do:

        result = await gate.execute(
            endpoint="search_tweet",
            cache_key=("search", q, product, count, cursor),
            cache_ttl=60,
            op=lambda client: client.search_tweet(q, product, count, cursor),
            serializer=serialize_tweet_result,
        )

    and never has to think about buckets, semaphores, or 429s. Errors
    from twikit are mapped to `GateResult.outcome` so the route returns
    structured JSON instead of raising HTTPException out of business
    code.

    `block_ceiling_s` is the longest the gate will wait inside a
    `bucket.acquire()` before returning a 429 to the caller. The MCP
    shim translates that 429 into a polite "retry in N seconds"
    response so the LLM backs off — don't make this larger than ~10s
    or the agent will think the tool is hung and start spawning
    parallel calls.
    """

    def __init__(self, pool, cache, *, block_ceiling_s: float = 10.0) -> None:
        self.pool = pool
        self.cache = cache
        self.block_ceiling_s = block_ceiling_s

    async def execute(
        self,
        *,
        endpoint: str,
        op: Callable[[object], Awaitable[T]],
        serializer: Callable[[T], object],
        cache_key: tuple | None = None,
        cache_ttl: int = 0,
        skip_cache: bool = False,
    ) -> GateResult:
        # 1. Cache check.
        if cache_key is not None and cache_ttl > 0 and not skip_cache:
            cached = self.cache.get(cache_key)
            if cached is not None:
                return GateResult(outcome="ok", value=cached)

        # 2. Pick an account.
        account = await self.pool.pick(endpoint)
        if account is None:
            return GateResult(outcome="no_account", value={"error": "No active Twitter account available"})

        bucket = account.bucket(endpoint)

        # 3. Decide whether to wait or to bounce. The wait check uses
        # the *current* bucket state; the queue ahead of us on the
        # semaphore can make the real wait longer. That's fine — we'll
        # re-check inside `bucket.acquire()` and bail out (via the loop
        # in Bucket.acquire) if the bucket ends up locked while we
        # waited.
        wait = bucket.time_until_available()
        if wait > self.block_ceiling_s:
            return GateResult(
                outcome="rate_limited",
                value={"retry_after_s": math.ceil(wait), "endpoint": endpoint},
                account_id=account.id,
            )

        # 4. Serialize twikit calls on this account so cookies don't race.
        # Import lazily to avoid hard dependency at module-import time
        # (handy for unit-testing Bucket/RateGate against fake clients).
        from twikit.errors import (
            AccountLocked,
            AccountSuspended,
            TooManyRequests,
            Unauthorized,
        )

        async with account.concurrency:
            # Acquire the bucket *inside* the semaphore. If we did it
            # outside, two concurrent requests to the same account
            # could each find tokens>=1, both decrement, and both
            # serialize on the semaphore — over-consuming by one token
            # per cycle. Holding the semaphore makes the acquire
            # atomic per account.
            await bucket.acquire()
            try:
                raw = await op(account.client)
            except TooManyRequests as e:
                bucket.mark_rate_limited(getattr(e, "rate_limit_reset", None))
                # Record this — `account_state` audit lets the operator
                # tell whether the trust_multiplier needs to come down.
                self.pool.record_429(account.id, endpoint)
                return GateResult(
                    outcome="rate_limited",
                    value={
                        "retry_after_s": math.ceil(bucket.time_until_available()),
                        "endpoint": endpoint,
                    },
                    account_id=account.id,
                )
            except AccountLocked as e:
                self.pool.mark_locked(account.id, str(e))
                return GateResult(
                    outcome="locked",
                    value={"error": "Account is locked (Arkose challenge). Solve in browser and re-login."},
                    account_id=account.id,
                )
            except AccountSuspended as e:
                self.pool.mark_suspended(account.id, str(e))
                return GateResult(
                    outcome="suspended",
                    value={"error": "Account has been suspended by X."},
                    account_id=account.id,
                )
            except Unauthorized as e:
                self.pool.mark_needs_relogin(account.id, str(e))
                return GateResult(
                    outcome="needs_relogin",
                    value={"error": "Session expired. Re-login required."},
                    account_id=account.id,
                )
            except asyncio.CancelledError:
                # Don't swallow cancellation — the route was aborted
                # (client disconnected) or the account is being deleted
                # (pool.remove() is mid-flight). Propagate so FastAPI
                # cleans up.
                raise
            except Exception as e:
                logger.exception("Twikit call failed: endpoint=%s account=%s", endpoint, account.id)
                return GateResult(outcome="error", value={"error": f"{type(e).__name__}: {e}"}, account_id=account.id)

        # 5. Serialize + cache.
        try:
            serialized = serializer(raw)
        except Exception as e:
            logger.exception("Serializer failed: endpoint=%s", endpoint)
            return GateResult(outcome="error", value={"error": f"serialize failed: {e}"}, account_id=account.id)

        # Never cache errors; we got here on success.
        if cache_key is not None and cache_ttl > 0:
            try:
                self.cache.set(cache_key, serialized, ttl=cache_ttl)
            except Exception as e:
                logger.warning("Cache set failed (non-fatal): %s", e)

        return GateResult(outcome="ok", value=serialized, account_id=account.id)
