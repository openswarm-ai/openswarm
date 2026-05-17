"""Twitter SubApp: FastAPI router + lifespan + module-level pool/gate.

The router exposes two flavors of route, both under `/api/twitter`:

- Admin: `/accounts/login`, `/accounts`, `/accounts/{id}` (PATCH/DELETE),
  `/accounts/{id}/verify`, `/accounts/{id}/health`. These manage the
  pool itself — adding accounts, checking session health, tuning the
  trust_multiplier.
- Tool reads: `/search`, `/user`, `/user/{id}/tweets`, `/tweet/{id}`,
  `/tweet/{id}/replies`. These are what the MCP shim calls on behalf
  of the LLM. Every one goes through `RateGate.execute` so cache hits
  short-circuit twikit, and 429s are translated into structured
  responses (`HTTP 429 + {"retry_after_s": N}`) the shim relays to the
  agent.

Module globals (`_pool`, `_gate`, etc.) are initialized inside the
lifespan context. Routes that touch them check for `None` and return
503 if the SubApp isn't ready yet (shouldn't happen in normal startup,
but defensive — tests sometimes import the router without running the
lifespan).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Optional
from uuid import uuid4

from fastapi import HTTPException, Query, Response

from backend.apps.twitter import persistence, serializers
from backend.apps.twitter.cache import TTLCache
from backend.apps.twitter.models import (
    AccountHealth,
    BucketSnapshot,
    CookieImportRequest,
    LoginRequest,
    TrustUpdateRequest,
    TwitterAccount,
)
from backend.apps.twitter.pool import AccountPool, ManagedAccount
from backend.apps.twitter.ratelimit import GateResult, RateGate
from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)


# Surface twikit drift at import time. If the wheel didn't ship (broken
# packaged build, missing dependency in dev), the routes will still 503
# correctly — but without this line the operator would have no idea
# whether twikit was the problem.
#
# We also apply our x_client_transaction regex patch here, *before* any
# Client/GuestClient is constructed (the patch hits a module-level class so
# instance order doesn't matter, but doing it at import keeps the dependency
# graph obvious). The patch is a workaround for twikit#408 and can be removed
# once a fixed twikit release is on PyPI.
try:
    import twikit as _twikit
    logger.info("twitter: twikit version %s", getattr(_twikit, "__version__", "unknown"))
    from backend.apps.twitter import _twikit_patches as _twikit_patches_mod
    _twikit_patches_mod.apply()
except ImportError as _e:
    logger.error("twitter: twikit not importable (%s); SubApp will 503 on every call", _e)


# ---------------------------------------------------------------------------
# Module-level singletons (initialized inside the lifespan)
# ---------------------------------------------------------------------------

_pool: AccountPool | None = None
_gate: RateGate | None = None
_cache: TTLCache | None = None
_snapshot_task: asyncio.Task | None = None
_probe_task: asyncio.Task | None = None
SNAPSHOT_INTERVAL_S = 1.0


def _require_started() -> AccountPool:
    """Raise 503 if the SubApp wasn't initialized.

    The token + middleware already returned by this point, so a 503
    here is unambiguous: the backend is up but the Twitter SubApp's
    lifespan didn't run (likely an import-time crash in twikit).
    """
    if _pool is None:
        raise HTTPException(503, "Twitter SubApp not ready")
    return _pool


# ---------------------------------------------------------------------------
# Lifespan: load state, start snapshot loop, smoke-probe twikit
# ---------------------------------------------------------------------------

async def _periodic_snapshot(pool: AccountPool) -> None:
    """Persist bucket state to sqlite at SNAPSHOT_INTERVAL_S.

    Sized at 1 second so a crash loses at most one second of decrements;
    combined with `Bucket.restore`'s `min(saved, capacity/2)` clamp the
    worst-case post-crash state is "we burned half a window's headroom",
    not "we 429-storm Twitter."
    """
    try:
        while True:
            try:
                pool.snapshot_all()
            except Exception:
                logger.exception("twitter: periodic snapshot failed")
            await asyncio.sleep(SNAPSHOT_INTERVAL_S)
    except asyncio.CancelledError:
        # Final snapshot on shutdown so the on-disk state matches
        # whatever decrement just happened.
        try:
            pool.snapshot_all()
        except Exception:
            logger.exception("twitter: final snapshot on shutdown failed")
        raise


async def _smoke_probe(pool: AccountPool) -> None:
    """One-shot `client.user()` on the first active account.

    This is our canary for twikit-wire-shape drift. If X rotated their
    GraphQL query IDs since the pinned twikit version was tested,
    we'll see an unexpected exception class here and we can both log
    loudly and write an audit row so /health surfaces the problem.

    Runs once at startup, never repeats. Uses the `_self_user` bucket
    so it can't accidentally drain user-visible budget.

    Skipped entirely in dev (`OPENSWARM_TWITTER_SKIP_PROBE=1`) so that
    hot-reload cycles don't burn the verify window on every restart.
    """
    if os.environ.get("OPENSWARM_TWITTER_SKIP_PROBE") == "1":
        logger.info("twitter: smoke probe skipped (OPENSWARM_TWITTER_SKIP_PROBE=1)")
        return

    for managed in pool.accounts:
        if managed.state != "active":
            continue
        try:
            bucket = managed.bucket("_self_user")
            if bucket.time_until_available() > 1.0:
                # Don't burn budget at startup; skip and rely on the
                # first /verify call to surface drift instead.
                pool.audit_lifecycle(managed.id, "smoke_probe_skip", "no budget")
                return
            async with managed.concurrency:
                await bucket.acquire()
                await managed.client.user()
            logger.info("twitter: startup smoke probe ok (%s)", managed.id)
            pool.mark_active(managed.id)
            pool.audit_lifecycle(managed.id, "smoke_probe_ok")
            pool.commit()
            return
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # Don't crash startup — log so the operator notices, mark
            # the account so the UI shows the failure, and write an
            # audit row so /health.recent_429_count's siblings can
            # surface the drift event to the operator without trawling
            # logs.
            logger.error(
                "twitter: startup smoke probe FAILED for %s (%s): %s — "
                "may indicate twikit/X wire-shape drift",
                managed.id,
                type(e).__name__,
                e,
            )
            pool.mark_needs_relogin(managed.id, f"smoke probe failed: {e}")
            pool.audit_lifecycle(managed.id, "smoke_probe_fail", f"{type(e).__name__}: {e}")
            pool.commit()
            return


async def _hydrate_pool(pool: AccountPool) -> None:
    """Reconstruct ManagedAccount instances from accounts.json + cookies.

    twikit's Client.set_cookies takes a dict directly. We read the
    saved cookies file (twikit-format) and feed it back in. If a
    cookies file is missing, we still register the account but mark
    it needs_relogin so the UI prompts a re-login.
    """
    import json as _json
    from twikit import Client

    for raw in persistence.load_accounts():
        try:
            record = TwitterAccount(**raw)
        except Exception as e:
            logger.warning("twitter: skip malformed account %s: %s", raw, e)
            continue

        client = Client(language="en-US", proxy=record.proxy or None)
        cookie_path = persistence.cookies_path(record.id)
        if os.path.isfile(cookie_path):
            try:
                with open(cookie_path) as f:
                    cookies = _json.load(f)
                client.set_cookies(cookies)
            except Exception as e:
                logger.warning(
                    "twitter: %s cookies unreadable (%s); marking needs_relogin",
                    record.id,
                    e,
                )
                record.state = "needs_relogin"
                record.last_error = "cookies unreadable"
        else:
            record.state = "needs_relogin"
            record.last_error = "no cookies on disk"

        await pool.add(record, client)


def _persist_accounts(pool: AccountPool) -> None:
    """Flush the public account state to accounts.json.

    Called after every mutation (login/delete/state change). Cheap —
    accounts.json is small and rewritten atomically.
    """
    persistence.save_accounts([a.record.model_dump() for a in pool.accounts])


@asynccontextmanager
async def twitter_lifespan():
    """Initialize SubApp state, start background tasks, clean up on exit."""
    global _pool, _gate, _cache, _snapshot_task, _probe_task

    persistence.ensure_dirs()
    conn = persistence.open_state_db()
    persistence.trim_audit(conn)

    _cache = TTLCache(conn)
    _pool = AccountPool(conn)
    _gate = RateGate(_pool, _cache, block_ceiling_s=10.0)

    await _hydrate_pool(_pool)
    # Hold the probe task so we can cancel it on shutdown — a bare
    # `asyncio.create_task` here was leaking on fast restarts and
    # surfacing as `Task was destroyed but it is pending!` warnings
    # under pytest.
    _probe_task = asyncio.create_task(_smoke_probe(_pool))
    _snapshot_task = asyncio.create_task(_periodic_snapshot(_pool))

    try:
        yield
    finally:
        for task in (_probe_task, _snapshot_task):
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("twitter: background task raised during shutdown")
        # Save cookies for every *active* account one last time. Cookies
        # can rotate during a session (twikit may refresh ct0 silently),
        # so this final flush is the difference between "next restart
        # works" and "next restart needs_relogin." We deliberately skip
        # non-active accounts: their `client` was constructed from a
        # broken cookies file (or none at all) and calling save_cookies()
        # would clobber whatever the user had on disk with garbage.
        if _pool is not None:
            for managed in _pool.accounts:
                if managed.state != "active":
                    continue
                try:
                    managed.client.save_cookies(persistence.cookies_path(managed.id))
                    persistence.chmod_cookies(persistence.cookies_path(managed.id))
                except Exception as e:
                    logger.warning("twitter: final cookie save failed for %s: %s", managed.id, e)
            # Only persist if we actually have accounts in memory. An empty
            # in-memory pool overwriting accounts.json is the
            # `import_cookies.py`-while-backend-shuts-down clobber: the
            # script's write to disk gets nuked by our shutdown writing
            # `[]` back. Skipping the persist when there's nothing to
            # persist can only ever destroy information, never add it, so
            # this guard is strictly safer. Mutating routes (`accounts_login`,
            # `accounts_delete`, etc.) already call `_persist_accounts` on
            # their own paths, so we're not relying on shutdown to flush
            # legitimate state changes.
            if _pool.accounts:
                _persist_accounts(_pool)
        try:
            conn.close()
        except Exception:
            pass


twitter = SubApp("twitter", twitter_lifespan)


# ---------------------------------------------------------------------------
# Per-endpoint cache TTLs
# ---------------------------------------------------------------------------

_CACHE_TTLS = {
    "search_tweet": 60,
    "get_user_by_screen_name": 300,
    "get_user_by_id": 300,
    "get_user_tweets": 120,
    "get_tweet_by_id": 30,
}


def _gate_result_to_response(result: GateResult, response: Response) -> object:
    """Translate `GateResult.outcome` into HTTP status + body.

    Keeps every tool route's tail identical: result -> response.
    """
    if result.outcome == "ok":
        return result.value
    if result.outcome == "rate_limited":
        response.status_code = 429
        # Return the structured retry-after the shim translates to MCP.
        return result.value
    if result.outcome == "no_account":
        response.status_code = 503
        return result.value
    if result.outcome in ("locked", "needs_relogin", "suspended"):
        response.status_code = 409  # account is in a bad state, not a 500
        return result.value
    # outcome == "error"
    response.status_code = 502
    return result.value


# ---------------------------------------------------------------------------
# Admin routes
# ---------------------------------------------------------------------------

@twitter.router.post("/accounts/login")
async def accounts_login(body: LoginRequest):
    """Log in and persist cookies. Handles both fresh accounts and re-login.

    The password is used once to call `client.login()` and then dropped
    on the floor — never stored, never logged.

    Re-login semantics: if any existing account has the same handle as
    the one we just logged into, we mutate that ManagedAccount in place
    so bucket state survives. Otherwise we create a fresh record.
    """
    pool = _require_started()
    persistence.ensure_dirs()

    from twikit import Client

    # We don't know the handle until after login (the user may have
    # logged in by email/phone). Create a Client, log in, *then* match.
    client = Client(language="en-US")
    # Random tmp filename per request — a fixed `_tmp_login` path used
    # to race when two browser tabs (or one double-submit) hit
    # /accounts/login concurrently and the second login could clobber
    # the first's cookies before os.replace ran.
    cookies_temp = persistence.cookies_path(f"_tmp_login_{uuid4().hex}")
    try:
        await client.login(
            auth_info_1=body.auth_info_1,
            auth_info_2=body.auth_info_2,
            password=body.password,
            totp_secret=body.totp_secret,
            cookies_file=cookies_temp,
        )
    except Exception as e:
        logger.warning("twitter: login failed for auth_info_1=%s: %s", body.auth_info_1, type(e).__name__)
        # Make sure we don't leave a partial cookies file behind.
        try:
            os.remove(cookies_temp)
        except OSError:
            pass
        raise HTTPException(401, f"Login failed: {type(e).__name__}: {e}")

    # Look up the just-authenticated handle so we can match against an
    # existing record (re-login path).
    try:
        me = await client.user()
        handle = getattr(me, "screen_name", None)
    except Exception as e:
        logger.warning("twitter: post-login client.user() failed: %s", e)
        handle = None

    existing = pool.by_handle(handle) if handle else None
    if existing is not None:
        # Re-login: keep the existing record's id, label, role, trust.
        existing.record.handle = handle or existing.record.handle
        existing.record.state = "active"
        existing.record.last_error = None
        existing.record.last_verified_at = time.time()
        if body.label:
            existing.record.label = body.label
        target_id = existing.id
    else:
        record = TwitterAccount(
            label=body.label or (handle or body.auth_info_1),
            handle=handle,
            role=body.role,
        )
        record.state = "active"
        record.last_verified_at = time.time()
        target_id = record.id

    # Move the temp cookies file to its permanent home (chmod 0600).
    final_cookies_path = persistence.cookies_path(target_id)
    try:
        os.replace(cookies_temp, final_cookies_path)
    except OSError as e:
        logger.warning("twitter: cookies rename failed: %s; falling back to save_cookies()", e)
        client.save_cookies(final_cookies_path)
    persistence.chmod_cookies(final_cookies_path)

    if existing is not None:
        await pool.add(existing.record, client)
        managed = existing
    else:
        managed = await pool.add(record, client)

    pool.audit_lifecycle(managed.id, "login_ok", handle or "")
    pool.commit()
    _persist_accounts(pool)

    return {"account": managed.record.model_dump()}


@twitter.router.post("/accounts/import")
async def accounts_import(body: CookieImportRequest):
    """Import browser-captured cookies into the pool.

    The Electron "Sign in with X" popup captures `auth_token` + `ct0`
    from x.com's session via `webContents.session.cookies.get(...)` and
    POSTs them here. This is the HTTP sibling of the
    `import_cookies.py` CLI: same on-disk layout (cookies file 0600 +
    accounts.json), but plugged straight into the live `AccountPool`
    so the import takes effect without a backend restart.

    Re-login semantics match `accounts_login`:
    - If `body.id` matches a pool entry, that account's cookies are
      overwritten in place and `pool.add` drains any in-flight call
      under the concurrency semaphore before swapping the Client.
    - Else if `body.handle` matches an existing account, same path
      keyed by handle (the UI's "refresh @alice's session" button).
    - Else a fresh uuid is minted.

    `_verify_account` runs inline (under the `_self_user` bucket, same
    as `POST /accounts/{id}/verify`) so the response immediately tells
    the UI whether the imported cookies are live. A failed verify
    flips state to `needs_relogin`/`locked`/`suspended`/etc but the
    route still returns 200 with the (possibly downgraded) record —
    the frontend surfaces the state, doesn't need a 4xx.

    Cookies are never echoed in the response body: the response shape
    `{ok, account}` mirrors `accounts_login` so the
    `test_accounts_list_excludes_cookies` contract stays green.
    """
    pool = _require_started()
    persistence.ensure_dirs()

    from twikit import Client

    cookies = {"auth_token": body.auth_token, "ct0": body.ct0}

    existing: Optional[ManagedAccount] = None
    if body.id:
        existing = pool.get(body.id)
    if existing is None and body.handle:
        existing = pool.by_handle(body.handle)

    if existing is not None:
        target_id = existing.id
        existing.record.state = "active"
        existing.record.last_error = None
        existing.record.last_verified_at = time.time()
        if body.label:
            existing.record.label = body.label
        if body.handle:
            existing.record.handle = body.handle.lstrip("@")
        record = existing.record
    else:
        target_id = body.id or uuid4().hex
        record = TwitterAccount(
            id=target_id,
            label=body.label or (body.handle.lstrip("@") if body.handle else "imported"),
            handle=body.handle.lstrip("@") if body.handle else None,
            role=body.role,
        )
        record.state = "active"
        record.last_verified_at = time.time()

    # Reuse the CLI's atomic-write helper so the on-disk format and
    # mode bits stay identical regardless of which entry point the
    # operator used (CLI vs HTTP).
    from backend.apps.twitter.import_cookies import _write_cookies
    _write_cookies(target_id, cookies)

    client = Client(language="en-US", proxy=record.proxy or None)
    try:
        client.set_cookies(cookies)
    except Exception as e:
        logger.warning("twitter: set_cookies failed for %s: %s", target_id, e)
        raise HTTPException(400, f"Invalid cookies: {type(e).__name__}: {e}")

    managed = await pool.add(record, client)

    # Inline verify against the live x.com — mirrors accounts_verify.
    # On failure _verify_account already audits + flips state; we just
    # capture the boolean for the response.
    ok = await _verify_account(pool, managed)

    pool.audit_lifecycle(managed.id, "cookie_import_ok", managed.record.handle or "")
    pool.commit()
    _persist_accounts(pool)

    return {"ok": ok, "account": managed.record.model_dump()}


@twitter.router.get("/accounts")
async def accounts_list():
    pool = _require_started()
    return {"accounts": [a.record.model_dump() for a in pool.accounts]}


@twitter.router.patch("/accounts/{account_id}")
async def accounts_patch(account_id: str, body: TrustUpdateRequest):
    pool = _require_started()
    managed = pool.get(account_id)
    if managed is None:
        raise HTTPException(404, "Account not found")
    managed.record.trust_multiplier = body.trust_multiplier
    managed.rescale_buckets()
    _persist_accounts(pool)
    return {"account": managed.record.model_dump()}


@twitter.router.delete("/accounts/{account_id}")
async def accounts_delete(account_id: str):
    pool = _require_started()
    managed = pool.get(account_id)
    if managed is None:
        # Idempotent: deleting an absent account isn't an error.
        return {"removed": True}

    clean = await pool.remove(account_id)
    persistence.delete_cookies(account_id)
    pool.audit_lifecycle(account_id, "delete")
    pool.commit()
    _persist_accounts(pool)
    return {"removed": True, "clean": clean}


async def _verify_account(pool: AccountPool, managed: ManagedAccount) -> bool:
    """Internal: call client.user() under the `_self_user` bucket.

    Asymmetric audit policy historically only logged verify_ok; we now
    also log verify_fail with the twikit exception class so /health can
    surface "why is this account stuck" without trawling the python log.
    """
    from twikit.errors import (
        AccountLocked,
        AccountSuspended,
        TooManyRequests,
        Unauthorized,
    )

    bucket = managed.bucket("_self_user")
    if bucket.time_until_available() > 1.0:
        # Don't wait — verify isn't critical. Return the current
        # state's truthiness so callers can fall back to "still active
        # from last successful verify."
        pool.audit_lifecycle(managed.id, "verify_skip", "no budget")
        pool.commit()
        return managed.state == "active"
    async with managed.concurrency:
        # Acquire the bucket inside the semaphore — same atomicity
        # rule as RateGate.execute, otherwise a concurrent verify +
        # tool call could each grab a token even though only one was
        # available.
        await bucket.acquire()
        try:
            me = await managed.client.user()
            handle = getattr(me, "screen_name", None) or managed.record.handle
            managed.record.handle = handle
            pool.mark_active(managed.id)
            # Cookies sometimes refresh in the response; persist any
            # diff. Cheapest correct thing: always save on verify_ok.
            try:
                managed.client.save_cookies(persistence.cookies_path(managed.id))
                persistence.chmod_cookies(persistence.cookies_path(managed.id))
            except Exception as e:
                logger.warning("twitter: cookie save after verify failed: %s", e)
            pool.audit_lifecycle(managed.id, "verify_ok")
            pool.commit()
            return True
        except TooManyRequests as e:
            bucket.mark_rate_limited(getattr(e, "rate_limit_reset", None))
            pool.audit_lifecycle(managed.id, "verify_fail", f"TooManyRequests: {e}")
            pool.commit()
            return False
        except AccountLocked as e:
            pool.mark_locked(managed.id, str(e))
            pool.audit_lifecycle(managed.id, "verify_fail", f"AccountLocked: {e}")
            pool.commit()
            return False
        except AccountSuspended as e:
            pool.mark_suspended(managed.id, str(e))
            pool.audit_lifecycle(managed.id, "verify_fail", f"AccountSuspended: {e}")
            pool.commit()
            return False
        except Unauthorized as e:
            pool.mark_needs_relogin(managed.id, str(e))
            pool.audit_lifecycle(managed.id, "verify_fail", f"Unauthorized: {e}")
            pool.commit()
            return False
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("twitter: verify failed for %s", managed.id)
            pool.audit_lifecycle(managed.id, "verify_fail", f"{type(e).__name__}: {e}")
            pool.commit()
            return False


@twitter.router.post("/accounts/{account_id}/verify")
async def accounts_verify(account_id: str):
    pool = _require_started()
    managed = pool.get(account_id)
    if managed is None:
        raise HTTPException(404, "Account not found")
    ok = await _verify_account(pool, managed)
    _persist_accounts(pool)
    return {"ok": ok, "account": managed.record.model_dump()}


@twitter.router.get("/accounts/{account_id}/health")
async def accounts_health(account_id: str) -> AccountHealth:
    """Snapshot of an account's runtime state. Does NOT call twikit.

    Served entirely from in-memory state + an audit-log query for the
    recent_429_count. Safe to poll aggressively from the frontend.
    """
    pool = _require_started()
    managed = pool.get(account_id)
    if managed is None:
        raise HTTPException(404, "Account not found")

    snaps: list[BucketSnapshot] = []
    for endpoint, b in managed._buckets.items():
        snaps.append(BucketSnapshot(
            endpoint=endpoint,
            capacity=b.capacity,
            tokens=round(b.tokens, 2),
            locked_until=b.locked_until,
            seconds_until_available=round(b.time_until_available(), 2),
        ))

    recent_429 = pool.recent_429s(account_id, since_s=24 * 3600)

    return AccountHealth(
        id=managed.id,
        label=managed.record.label,
        handle=managed.record.handle,
        state=managed.state,
        role=managed.role,
        trust_multiplier=managed.trust_multiplier,
        last_verified_at=managed.record.last_verified_at,
        last_error=managed.record.last_error,
        recent_429_count=recent_429,
        buckets=snaps,
    )


# ---------------------------------------------------------------------------
# Tool read routes — these are what the MCP shim hits
# ---------------------------------------------------------------------------

@twitter.router.get("/search")
async def tool_search(
    response: Response,
    q: str = Query(..., min_length=1),
    product: str = Query("Latest", pattern="^(Top|Latest|Media)$"),
    count: int = Query(20, ge=1, le=50),
    cursor: Optional[str] = None,
):
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.search_tweet(q, product, count, cursor)

    def serialize(result):
        return serializers.result_to_dict(result, serializers.tweet_to_dict)

    res = await _gate.execute(
        endpoint="search_tweet",
        op=op,
        serializer=serialize,
        cache_key=("search", q, product, count, cursor or ""),
        cache_ttl=_CACHE_TTLS["search_tweet"],
    )
    return _gate_result_to_response(res, response)


@twitter.router.get("/user")
async def tool_get_user(
    response: Response,
    handle: Optional[str] = None,
    user_id: Optional[str] = Query(None, alias="id"),
):
    """Lookup by handle or by id; exactly one required."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")
    if bool(handle) == bool(user_id):
        raise HTTPException(400, "specify exactly one of: handle, id")

    if handle:
        endpoint = "get_user_by_screen_name"
        norm_handle = handle.lstrip("@")

        async def op(client):
            return await client.get_user_by_screen_name(norm_handle)

        cache_key = ("user_by_handle", norm_handle.lower())
    else:
        endpoint = "get_user_by_id"

        async def op(client):
            return await client.get_user_by_id(user_id)

        cache_key = ("user_by_id", user_id)

    res = await _gate.execute(
        endpoint=endpoint,
        op=op,
        serializer=serializers.user_to_dict,
        cache_key=cache_key,
        cache_ttl=_CACHE_TTLS[endpoint],
    )
    return _gate_result_to_response(res, response)


@twitter.router.get("/user/{user_id}/tweets")
async def tool_get_user_tweets(
    user_id: str,
    response: Response,
    type: str = Query("Tweets", pattern="^(Tweets|Replies|Media|Likes)$"),
    count: int = Query(20, ge=1, le=50),
    cursor: Optional[str] = None,
):
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.get_user_tweets(user_id, type, count, cursor)

    def serialize(result):
        return serializers.result_to_dict(result, serializers.tweet_to_dict)

    res = await _gate.execute(
        endpoint="get_user_tweets",
        op=op,
        serializer=serialize,
        cache_key=("user_tweets", user_id, type, count, cursor or ""),
        cache_ttl=_CACHE_TTLS["get_user_tweets"],
    )
    return _gate_result_to_response(res, response)


@twitter.router.get("/tweet/{tweet_id}")
async def tool_get_tweet(tweet_id: str, response: Response):
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.get_tweet_by_id(tweet_id)

    res = await _gate.execute(
        endpoint="get_tweet_by_id",
        op=op,
        serializer=lambda t: serializers.tweet_to_dict(t, include_replies=False),
        cache_key=("tweet", tweet_id),
        cache_ttl=_CACHE_TTLS["get_tweet_by_id"],
    )
    return _gate_result_to_response(res, response)


@twitter.router.get("/tweet/{tweet_id}/replies")
async def tool_get_tweet_replies(
    tweet_id: str,
    response: Response,
    cursor: Optional[str] = None,
):
    """Replies share the get_tweet_by_id endpoint — same bucket.

    twikit's `get_tweet_by_id(id, cursor=...)` returns a Tweet whose
    `.replies` is a Result of replies for that cursor page. We
    serialize only the replies (not the parent tweet) so the agent
    isn't fed duplicate context.
    """
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.get_tweet_by_id(tweet_id, cursor=cursor)

    def serialize(tweet):
        replies = getattr(tweet, "replies", None)
        if replies is None:
            return {"items": [], "next_cursor": None, "previous_cursor": None}
        return serializers.result_to_dict(replies, serializers.tweet_to_dict)

    res = await _gate.execute(
        endpoint="get_tweet_by_id",  # shares the parent endpoint's bucket
        op=op,
        serializer=serialize,
        cache_key=("tweet_replies", tweet_id, cursor or ""),
        cache_ttl=_CACHE_TTLS["get_tweet_by_id"],
    )
    return _gate_result_to_response(res, response)


# ---------------------------------------------------------------------------
# Stats — small operator endpoint (not consumed by MCP)
# ---------------------------------------------------------------------------

@twitter.router.get("/stats")
async def stats():
    pool = _require_started()
    cache_stats = _cache.stats() if _cache else {}
    return {
        "accounts": len(pool.accounts),
        "active_accounts": sum(1 for a in pool.accounts if a.state == "active"),
        "cache": cache_stats,
    }
