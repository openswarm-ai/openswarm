"""ManagedAccount + AccountPool: the live state of each logged-in account.

A `ManagedAccount` wraps a single `twikit.Client` together with:
- per-endpoint `Bucket` instances (rate budget)
- an `asyncio.Semaphore(1)` so we never run two twikit calls in parallel
  on the same Client (cookies would race + X would flag the pattern)
- the mutable lifecycle state (`active` / `locked` / `needs_relogin` /
  `suspended`) and the `trust_multiplier` knob

The `AccountPool` is the registry that the routes go through. It
exposes:

- `pick(endpoint)` — returns the active account whose bucket frees up
  soonest. Returns `None` if no active accounts exist.
- `add(account, client)` — runtime hand-off from the login route. Sets
  up buckets, kicks off persistence wiring.
- `remove(account_id)` — waits for any in-flight call (under the
  semaphore, with a hard cap of `REMOVE_TIMEOUT_S`) then disposes the
  Client. Returns False if the timeout fired (caller decides whether
  to force or 503).
- `mark_locked` / `mark_suspended` / `mark_needs_relogin` / `record_429`
  — side-effect hooks called by `RateGate` on twikit errors.

Why module-level globals: this matches the rest of OpenSwarm's SubApp
pattern (`mcp_registry` uses module-level `_cache`, `_refresh_task`,
etc.). Routes import the pool object directly. Single-process backend,
so no cross-process coordination needed.
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Optional

from backend.apps.twitter import persistence
from backend.apps.twitter.models import TwitterAccount
from backend.apps.twitter.ratelimit import (
    DEFAULT_BUDGETS,
    Bucket,
)

logger = logging.getLogger(__name__)

# How long `remove()` waits for an in-flight call before giving up and
# letting the route return 503. The semaphore is held only for the
# duration of a single twikit GraphQL call (a few seconds upper bound
# in normal operation); 5s is generous enough that we never preempt
# legitimate work and short enough that a deleted account doesn't
# stall the UI.
REMOVE_TIMEOUT_S: float = 5.0

# Same idea for the re-login path: when /accounts/login swaps a fresh
# twikit.Client onto an existing ManagedAccount, we want any in-flight
# tool call on the old Client to finish first. Otherwise the call sees
# its cookies replaced mid-request. Same budget as REMOVE_TIMEOUT_S
# (one twikit call's worth).
REPLACE_CLIENT_TIMEOUT_S: float = 5.0


@dataclass
class ManagedAccount:
    """One live account in the pool.

    `record` is the public-facing `TwitterAccount` we serialize via the
    API. Mutable lifecycle state lives directly on `record.state`. The
    Client + semaphore + buckets are runtime-only and never leave the
    pool.
    """

    record: TwitterAccount
    client: object  # twikit.client.client.Client — duck-typed so tests don't need twikit
    concurrency: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(1))
    _buckets: dict[str, Bucket] = field(default_factory=dict)

    # ---- record passthrough conveniences ------------------------------
    @property
    def id(self) -> str:
        return self.record.id

    @property
    def state(self) -> str:
        return self.record.state

    @property
    def role(self) -> str:
        return self.record.role

    @property
    def trust_multiplier(self) -> float:
        return self.record.trust_multiplier

    # ---- buckets -------------------------------------------------------

    def bucket(self, endpoint: str) -> Bucket:
        """Lazy-create the bucket for this endpoint at trust-scaled capacity.

        Lazy creation matters because we don't pre-allocate every
        endpoint at startup — a long-lived process might only ever
        touch `search_tweet`, and creating buckets we don't use is
        wasted state.

        Capacity floors to 0 (paused) rather than 1; the Bucket math
        handles capacity=0 by returning a long sentinel wait so pick()
        deprioritizes paused accounts but doesn't crash.
        """
        if endpoint not in self._buckets:
            base = DEFAULT_BUDGETS.get(endpoint, 20)
            cap = max(0, int(round(base * self.trust_multiplier)))
            self._buckets[endpoint] = Bucket(capacity=cap)
        return self._buckets[endpoint]

    def restore_buckets(self, snapshots: dict[str, dict]) -> None:
        """On startup, replace each Bucket with one restored from disk.

        Crash-safe: `Bucket.restore` clamps tokens to `capacity / 2`
        regardless of what was on disk, so an unclean shutdown can't
        leak budget into a post-restart burst.
        """
        for endpoint, snap in snapshots.items():
            try:
                self._buckets[endpoint] = Bucket.restore(snap)
            except Exception as e:
                logger.warning(
                    "twitter: bucket restore failed for %s/%s: %s",
                    self.id,
                    endpoint,
                    e,
                )

    def rescale_buckets(self) -> None:
        """Re-apply `trust_multiplier` after a PATCH.

        Raising the multiplier widens the ceiling; existing `tokens`
        carry over so the bucket starts under the new cap and refills
        normally. Lowering the multiplier clamps `tokens` down to the
        new ceiling so we can't burst on the next call. We do not
        invent tokens out of thin air on a raise — refill is what
        replenishes within the 15-min window.

        A `trust_multiplier` of 0 effectively pauses the account: the
        capacity gets floored to 0 and `pick()` will skip endpoints
        whose `time_until_available()` is huge (the bucket never
        refills past zero).
        """
        for endpoint, bucket in list(self._buckets.items()):
            base = DEFAULT_BUDGETS.get(endpoint, 20)
            new_cap = max(0, int(round(base * self.trust_multiplier)))
            if new_cap == bucket.capacity:
                continue
            bucket.capacity = new_cap
            if bucket.tokens > new_cap:
                bucket.tokens = float(new_cap)


class AccountPool:
    """Registry of `ManagedAccount` instances and pick/lifecycle ops."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._accounts: dict[str, ManagedAccount] = {}
        # Tracks remove-in-progress account IDs so concurrent pick()s
        # don't return an account that's about to be disposed.
        self._removing: set[str] = set()
        self._lock = asyncio.Lock()

    # ---- introspection -------------------------------------------------

    @property
    def accounts(self) -> list[ManagedAccount]:
        return list(self._accounts.values())

    def get(self, account_id: str) -> Optional[ManagedAccount]:
        return self._accounts.get(account_id)

    def by_handle(self, handle: str) -> Optional[ManagedAccount]:
        """Find an account by @screen_name. Used by /login for re-login
        on a stuck account (locked/needs_relogin) — same handle = same
        ManagedAccount, we just refresh its cookies in place rather
        than create a new entry."""
        h = handle.lstrip("@").lower()
        for acct in self._accounts.values():
            if acct.record.handle and acct.record.handle.lower() == h:
                return acct
        return None

    # ---- picking -------------------------------------------------------

    async def pick(self, endpoint: str) -> Optional[ManagedAccount]:
        """Choose the active account with the soonest availability.

        Skips:
        - accounts being removed (we'd race the disposal)
        - any state != "active"
        Among active accounts, breaks ties by `time_until_available()`
        on this endpoint's bucket. With one account this is just "is
        it active and not being removed."
        """
        candidates = [
            a for a in self._accounts.values()
            if a.id not in self._removing and a.state == "active"
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda a: a.bucket(endpoint).time_until_available())
        return candidates[0]

    async def pick_writable(self, endpoint: str) -> Optional[ManagedAccount]:
        """Like `pick()` but only considers accounts authorized to write.

        Writes (`create_tweet`, `favorite_tweet`, `retweet`, `follow_user`,
        ...) mutate the user's identity on x.com and shouldn't fan out
        across accounts the operator has dialed back to read-only. We
        gate them by the `role` field on `TwitterAccount` (default
        "primary"), which is plumbed end-to-end already — only the
        gate/pool was ignoring it.

        Returns None when no eligible account exists. The RateGate
        translates that into a `no_account` outcome → HTTP 503 with a
        helpful body, same as `pick()` does for reads.

        An operator can demote an account to "read_only" to keep it in
        the pool for search/lookup traffic while preventing writes
        through it (e.g. a flaky session that's hit a 429 too many times
        on POSTs but is otherwise fine for GETs).
        """
        candidates = [
            a for a in self._accounts.values()
            if a.id not in self._removing
            and a.state == "active"
            and a.role == "primary"
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda a: a.bucket(endpoint).time_until_available())
        return candidates[0]

    # ---- mutation ------------------------------------------------------

    async def add(self, account: TwitterAccount, client: object) -> ManagedAccount:
        """Register a freshly-logged-in account. Idempotent for re-login.

        If `account.id` is already in the pool, we replace the Client
        in place. This is the re-login-after-lock path: the login route
        matches by handle, finds the existing record, calls `login()`
        on the existing Client (or a fresh one), then hands us the
        result here. We keep the same `ManagedAccount` so the buckets'
        runtime state survives a re-login (no reason to discard
        partially-used budget).

        Re-login waits for any in-flight twikit call (under the
        account's concurrency semaphore) before swapping the Client.
        Without this, a request that was halfway through GraphQL would
        come back to a fresh Client whose cookies don't match the one
        it started on — symptom is mysterious deserialization errors
        or session drift. Times out at REPLACE_CLIENT_TIMEOUT_S; if
        the in-flight call is stuck, we swap anyway (the alternative
        is stranding the re-login indefinitely).
        """
        async with self._lock:
            existing = self._accounts.get(account.id)

        if existing is not None:
            # Drain the in-flight call BEFORE swapping the Client.
            try:
                await asyncio.wait_for(
                    existing.concurrency.acquire(),
                    timeout=REPLACE_CLIENT_TIMEOUT_S,
                )
                try:
                    existing.record = account
                    existing.client = client
                    snaps = persistence.load_buckets(self._conn, account.id)
                    if snaps:
                        existing.restore_buckets(snaps)
                finally:
                    existing.concurrency.release()
            except asyncio.TimeoutError:
                logger.warning(
                    "twitter: re-login swap timed out for %s after %.1fs; "
                    "swapping Client without semaphore (in-flight call "
                    "may see cookie drift)",
                    account.id,
                    REPLACE_CLIENT_TIMEOUT_S,
                )
                existing.record = account
                existing.client = client
                snaps = persistence.load_buckets(self._conn, account.id)
                if snaps:
                    existing.restore_buckets(snaps)
            return existing

        async with self._lock:
            # Race window check: someone else might have added in
            # between our two lock acquisitions. Cheap to re-check.
            already = self._accounts.get(account.id)
            if already is not None:
                return already
            managed = ManagedAccount(record=account, client=client)
            snaps = persistence.load_buckets(self._conn, account.id)
            if snaps:
                managed.restore_buckets(snaps)
            self._accounts[account.id] = managed
            return managed

    async def dedupe_by_handle(self, handle: str, keep_id: str) -> list[str]:
        """Remove every other ManagedAccount that shares this handle.

        Preserves the invariant "at most one pool entry per X identity"
        on every login/import path. Removal goes through `remove()` so
        any in-flight call on the loser drains under its semaphore
        first, and its cookies file is deleted from disk by the caller-
        equivalent path (`persistence.delete_cookies`).

        `keep_id` is the canonical winner — typically the entry the
        route just upserted. Other entries with the same lowercased
        handle are collapsed into a single audit + remove + cookie wipe.

        Returns the ids that were removed (empty list when this was a
        no-op). Audit policy: one `dedupe_removed` lifecycle row per
        loser, with the keeper's id as detail so an operator combing
        through audit later can reconstruct which entry won.
        """
        norm = handle.lstrip("@").lower()
        losers = [
            a.id for a in self._accounts.values()
            if a.id != keep_id
            and a.record.handle
            and a.record.handle.lstrip("@").lower() == norm
        ]
        for loser_id in losers:
            await self.remove(loser_id, wipe_buckets=True)
            persistence.delete_cookies(loser_id)
            self.audit_lifecycle(loser_id, "dedupe_removed", f"kept={keep_id}")
        return losers

    async def remove(self, account_id: str, *, wipe_buckets: bool = True) -> bool:
        """Remove an account, awaiting any in-flight call.

        Returns True on clean removal, False if `REMOVE_TIMEOUT_S` fired
        while waiting for the semaphore (in which case we evict from
        the dict anyway and the in-flight call will see `CancelledError`
        when it next yields).

        `wipe_buckets=True` is the normal path (DELETE endpoint); set
        False if a caller wants to keep the budget state around (e.g.
        replacing a logged-out account with a re-login).
        """
        async with self._lock:
            managed = self._accounts.pop(account_id, None)
            if managed is None:
                return True
            self._removing.add(account_id)

        try:
            # Acquire the semaphore so we know no twikit call is mid-
            # flight before we let go of the Client. The shield + wait_for
            # combo means: if the in-flight call wraps up within
            # REMOVE_TIMEOUT_S, we get a clean acquire; if not, we
            # bail and let the call error out on its own.
            try:
                await asyncio.wait_for(
                    managed.concurrency.acquire(),
                    timeout=REMOVE_TIMEOUT_S,
                )
                managed.concurrency.release()
                clean = True
            except asyncio.TimeoutError:
                logger.warning(
                    "twitter: remove(%s) timed out waiting for in-flight call",
                    account_id,
                )
                clean = False

            if wipe_buckets:
                persistence.delete_buckets_for(self._conn, account_id)
            return clean
        finally:
            self._removing.discard(account_id)

    # ---- audit / commit (keep the routes out of pool._conn) ------------

    def audit_lifecycle(self, account_id: str, event: str, detail: str | None = None) -> None:
        """Write a `_lifecycle`-endpoint audit row (login_ok, delete, ...).

        Routes used to call `persistence.audit(pool._conn, ...)` directly,
        which leaked the sqlite connection through. This is the same
        thing with the endpoint fixed and the private kept private.
        """
        persistence.audit(self._conn, account_id, "_lifecycle", event, detail)

    def commit(self) -> None:
        """Flush the underlying audit/state writes.

        The snapshot loop commits ~1Hz, so most callers don't need
        this — but the login/delete/verify routes do, because they
        return to the user immediately and we want their audit rows
        durable before the response goes out.
        """
        self._conn.commit()

    def recent_429s(self, account_id: str, since_s: float) -> int:
        """Count 429 audit rows in the last `since_s` seconds. Used by /health."""
        return persistence.recent_429s(self._conn, account_id, since_s=since_s)

    # ---- side-effect hooks (called by RateGate on twikit errors) -------

    def record_429(self, account_id: str, endpoint: str) -> None:
        persistence.audit(self._conn, account_id, endpoint, "429")
        # No commit — the snapshot loop commits ~1Hz and audit writes
        # ride along. If we crash before the commit we lose a few
        # audit rows; nobody depends on those for correctness.

    def mark_locked(self, account_id: str, reason: str) -> None:
        acct = self._accounts.get(account_id)
        if acct is not None:
            acct.record.state = "locked"
            acct.record.last_error = reason
        persistence.audit(self._conn, account_id, "_lifecycle", "locked", reason)

    def mark_suspended(self, account_id: str, reason: str) -> None:
        acct = self._accounts.get(account_id)
        if acct is not None:
            acct.record.state = "suspended"
            acct.record.last_error = reason
        persistence.audit(self._conn, account_id, "_lifecycle", "suspended", reason)

    def mark_needs_relogin(self, account_id: str, reason: str) -> None:
        acct = self._accounts.get(account_id)
        if acct is not None:
            acct.record.state = "needs_relogin"
            acct.record.last_error = reason
        persistence.audit(self._conn, account_id, "_lifecycle", "needs_relogin", reason)

    def mark_active(self, account_id: str) -> None:
        """Called after a successful login or verify."""
        acct = self._accounts.get(account_id)
        if acct is not None:
            acct.record.state = "active"
            acct.record.last_error = None
            acct.record.last_verified_at = time.time()

    # ---- snapshotting --------------------------------------------------

    def snapshot_all(self) -> None:
        """Write every bucket's current state to sqlite. Idempotent.

        Called by the lifespan's periodic snapshot task (~1Hz) and on
        shutdown. Cheap because sqlite is local + WAL mode; the heavy
        lifting is just the UPSERTs.
        """
        for managed in self._accounts.values():
            for endpoint, bucket in managed._buckets.items():
                persistence.save_bucket(self._conn, managed.id, endpoint, bucket.snapshot())
        self._conn.commit()
