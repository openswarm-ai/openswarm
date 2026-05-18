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
    AddDMReactionRequest,
    AddGroupMembersRequest,
    AddGroupReactionRequest,
    BucketSnapshot,
    ChangeGroupNameRequest,
    CookieImportRequest,
    CreateTweetRequest,
    LoginRequest,
    SendDMRequest,
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

    One-time dedupe pass after loading: prior versions of
    `accounts_import` could leave the on-disk state with multiple
    entries sharing the same X handle (each webview re-auth minted a
    fresh uuid instead of swapping in place). We collapse those groups
    here so the live pool starts with the invariant "at most one entry
    per X identity" holding, regardless of what's on disk.
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

    # Collapse same-handle duplicates left over from the pre-dedupe
    # accounts_import. Records with handle=None are skipped — they were
    # never verified, so we can't prove they belong to the same X
    # identity as any other entry; safer to leave them alone and let
    # the next verify/import decide.
    by_handle: dict[str, list[ManagedAccount]] = {}
    for managed in pool.accounts:
        h = managed.record.handle
        if not h:
            continue
        by_handle.setdefault(h.lstrip("@").lower(), []).append(managed)

    removed_any = False
    for _norm, group in by_handle.items():
        if len(group) <= 1:
            continue
        # Canonical winner ordering: state=="active" wins over anything
        # else, then most recent last_verified_at, then earliest
        # created_at as a deterministic tiebreaker. The keeper is the
        # FIRST item after sort.
        group.sort(
            key=lambda m: (
                0 if m.record.state == "active" else 1,
                -m.record.last_verified_at,
                m.record.created_at,
            )
        )
        keeper = group[0]
        for loser in group[1:]:
            logger.info(
                "twitter: startup dedupe — collapsing duplicate %s into %s (handle=%s)",
                loser.id,
                keeper.id,
                keeper.record.handle,
            )
            await pool.remove(loser.id, wipe_buckets=True)
            persistence.delete_cookies(loser.id)
            pool.audit_lifecycle(loser.id, "startup_dedupe", f"kept={keeper.id}")
            removed_any = True

    if removed_any:
        pool.commit()
        _persist_accounts(pool)


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
    # DM reads. Short TTLs because callers expect near-real-time
    # semantics; the cache is still useful for the within-turn retry
    # case (agent retries the same tool a second later).
    "dm_conversation": 15,
    "get_group": 60,
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

    # Collapse any pre-existing same-handle duplicates left over from
    # the old import-then-mint-new-uuid bug. New logins/imports
    # already dedupe by handle ABOVE; this call is what cleans up
    # whatever historical duplicates are still loaded in the pool.
    if managed.record.handle:
        await pool.dedupe_by_handle(managed.record.handle, keep_id=managed.id)

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

    Dedupe is keyed off the handle the *cookies themselves* prove. We
    build the twikit Client, set the cookies, and call `client.user()`
    as a preflight — that gives us the authoritative screen_name
    BEFORE we choose a target id. The previous order (pool.add →
    _verify_account) meant a webview re-auth always minted a fresh
    uuid (the UI doesn't carry the prior id), which accumulated
    duplicates of the same X identity. Pulling the dedupe forward
    fixes the re-auth path without requiring frontend changes.

    Dedupe precedence:
    1. `body.id` — explicit id from the caller (CLI re-login).
    2. preflight-discovered handle (`client.user().screen_name`) —
       authoritative because it's derived from the cookies presented.
    3. `body.handle` — caller-supplied hint, consulted only when the
       preflight failed (e.g. 429 / Unauthorized / network), so we
       still get a chance to dedupe via the UI's known handle.

    Bad-cookies policy: a failed preflight does NOT block the import.
    We still register the cookies and flip state to `needs_relogin`
    so the UI can surface "imported but verify failed" without losing
    the user's freshly-captured tokens. The route always returns 200;
    the body's `ok` and `account.state` carry the diagnosis.

    Cookies are never echoed in the response body: the response shape
    `{ok, account}` mirrors `accounts_login` so the
    `test_accounts_list_excludes_cookies` contract stays green.
    """
    pool = _require_started()
    persistence.ensure_dirs()

    from twikit import Client

    cookies = {"auth_token": body.auth_token, "ct0": body.ct0}

    # Hoisted from the old post-pool.add position: build the Client
    # and set cookies up front so the preflight client.user() below
    # can prove the handle BEFORE we pick a target id.
    client = Client(language="en-US")
    try:
        client.set_cookies(cookies)
    except Exception as e:
        logger.warning("twitter: set_cookies failed: %s", e)
        raise HTTPException(400, f"Invalid cookies: {type(e).__name__}: {e}")

    discovered_handle: Optional[str] = None
    preflight_error: Optional[Exception] = None
    try:
        me = await client.user()
        discovered_handle = getattr(me, "screen_name", None)
    except asyncio.CancelledError:
        raise
    except Exception as e:
        preflight_error = e
        logger.warning(
            "twitter: import preflight client.user() failed (%s: %s); "
            "registering cookies anyway and flipping to needs_relogin",
            type(e).__name__,
            e,
        )

    # Dedupe precedence: explicit id > authoritative cookie-derived
    # handle > caller-supplied handle hint (fallback for preflight
    # failure).
    existing: Optional[ManagedAccount] = None
    if body.id:
        existing = pool.get(body.id)
    if existing is None and discovered_handle:
        existing = pool.by_handle(discovered_handle)
    if existing is None and body.handle:
        existing = pool.by_handle(body.handle)

    if existing is not None:
        target_id = existing.id
        if body.label:
            existing.record.label = body.label
        if discovered_handle:
            existing.record.handle = discovered_handle
        elif body.handle:
            existing.record.handle = body.handle.lstrip("@")
        record = existing.record
    else:
        target_id = body.id or uuid4().hex
        new_handle = discovered_handle or (
            body.handle.lstrip("@") if body.handle else None
        )
        record = TwitterAccount(
            id=target_id,
            label=body.label or (new_handle or "imported"),
            handle=new_handle,
            role=body.role,
        )

    # Atomic-write cookies under the chosen target id (overwrites the
    # existing file on re-auth). Reuse the CLI's helper so the on-disk
    # format/mode bits stay identical across CLI vs HTTP entry points.
    from backend.apps.twitter.import_cookies import _write_cookies
    _write_cookies(target_id, cookies)

    managed = await pool.add(record, client)

    if preflight_error is None:
        # mark_active stamps last_verified_at, clears last_error, and
        # sets state="active". Subsumes what _verify_account used to
        # do after the (now-redundant) second client.user() call.
        pool.mark_active(managed.id)
        pool.audit_lifecycle(
            managed.id, "cookie_import_ok", managed.record.handle or ""
        )
        ok = True
    else:
        pool.mark_needs_relogin(
            managed.id,
            f"import preflight failed: {type(preflight_error).__name__}: {preflight_error}",
        )
        pool.audit_lifecycle(
            managed.id,
            "cookie_import_fail",
            f"{type(preflight_error).__name__}: {preflight_error}",
        )
        ok = False

    # Collapse any pre-existing entries that share this handle so the
    # pool's "one entry per X identity" invariant holds after every
    # import. No-op when this is the only entry with that handle, or
    # when we couldn't determine a handle (preflight failed AND no
    # body.handle hint).
    if managed.record.handle:
        await pool.dedupe_by_handle(managed.record.handle, keep_id=managed.id)

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
# Tool write routes — mutate state on x.com
# ---------------------------------------------------------------------------
#
# Every route here passes `writable=True` to the gate. That:
#  1. routes through `pool.pick_writable()` (skips read_only accounts),
#  2. coerces `cache_key`/`cache_ttl` to None inside the gate so a write
#     receipt can never end up cached, and
#  3. inherits the same 429/409/503/502 mapping as reads via
#     `_gate_result_to_response`.
#
# Cache invalidation after writes is intentionally NOT done here: the
# read TTLs are short enough (30-300s) that the eventual-consistency
# window is acceptable. If a stale read becomes a UX issue, add a
# `TTLCache.invalidate_prefix(prefix)` helper and call it after the
# relevant mutations.

@twitter.router.post("/tweets")
async def tool_create_tweet(body: CreateTweetRequest, response: Response):
    """Post a tweet, a reply, or a quote.

    `text` is required. `reply_to=<tweet_id>` turns it into a reply
    (the gate's twikit call uses twikit's `reply_to=` kwarg). Quote
    tweets pass `attachment_url=<full https://x.com/.../status/...
    URL>`. Both `reply_to` and `attachment_url` can coexist for a
    quote-reply, though that combination is uncommon.

    Media upload (`media_ids`) is forwarded if provided. Today there's
    no upload route in the SubApp, so this only works if the caller
    has separately obtained media_ids via twikit's own API — a future
    upload route can stitch in without touching this one.
    """
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        kwargs: dict = {}
        if body.reply_to:
            kwargs["reply_to"] = body.reply_to
        if body.attachment_url:
            kwargs["attachment_url"] = body.attachment_url
        if body.media_ids:
            kwargs["media_ids"] = body.media_ids
        return await client.create_tweet(body.text, **kwargs)

    res = await _gate.execute(
        endpoint="create_tweet",
        op=op,
        serializer=lambda t: serializers.tweet_to_dict(t, include_replies=False),
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.delete("/tweets/{tweet_id}")
async def tool_delete_tweet(tweet_id: str, response: Response):
    """Delete one of the authenticated user's own tweets.

    Only succeeds for tweets owned by the account picked by
    `pick_writable`. X returns 403 (which surfaces as a twikit
    exception → 502 from the gate) for tweets owned by other users.
    """
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.delete_tweet(tweet_id)

    res = await _gate.execute(
        endpoint="delete_tweet",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.post("/tweets/{tweet_id}/favorite")
async def tool_favorite_tweet(tweet_id: str, response: Response):
    """Like (favorite) a tweet."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.favorite_tweet(tweet_id)

    res = await _gate.execute(
        endpoint="favorite_tweet",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.delete("/tweets/{tweet_id}/favorite")
async def tool_unfavorite_tweet(tweet_id: str, response: Response):
    """Unlike (unfavorite) a tweet."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.unfavorite_tweet(tweet_id)

    res = await _gate.execute(
        endpoint="unfavorite_tweet",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.post("/tweets/{tweet_id}/retweet")
async def tool_retweet(tweet_id: str, response: Response):
    """Retweet a tweet."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.retweet(tweet_id)

    res = await _gate.execute(
        endpoint="retweet",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.delete("/tweets/{tweet_id}/retweet")
async def tool_delete_retweet(tweet_id: str, response: Response):
    """Undo a retweet."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.delete_retweet(tweet_id)

    res = await _gate.execute(
        endpoint="delete_retweet",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.post("/tweets/{tweet_id}/bookmark")
async def tool_bookmark_tweet(tweet_id: str, response: Response):
    """Bookmark a tweet."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.bookmark_tweet(tweet_id)

    res = await _gate.execute(
        endpoint="bookmark_tweet",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.delete("/tweets/{tweet_id}/bookmark")
async def tool_delete_bookmark(tweet_id: str, response: Response):
    """Remove a tweet from bookmarks."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.delete_bookmark(tweet_id)

    res = await _gate.execute(
        endpoint="delete_bookmark",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.post("/users/{user_id}/follow")
async def tool_follow_user(user_id: str, response: Response):
    """Follow a user by id.

    twikit's `follow_user` returns the followed `User`, so the response
    body carries the same shape as `GET /user` — the agent can use the
    returned profile data without an extra lookup.
    """
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.follow_user(user_id)

    res = await _gate.execute(
        endpoint="follow_user",
        op=op,
        serializer=serializers.user_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.delete("/users/{user_id}/follow")
async def tool_unfollow_user(user_id: str, response: Response):
    """Unfollow a user by id."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.unfollow_user(user_id)

    res = await _gate.execute(
        endpoint="unfollow_user",
        op=op,
        serializer=serializers.user_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


# ---------------------------------------------------------------------------
# Direct messages (1:1)
#
# All write routes pass `writable=True` so they only ever land on
# role=primary accounts (`pool.pick_writable`) and bypass the cache.
# Read routes use the regular `pick` and cache with a short TTL.
#
# `send_dm` and the 1:1 reaction routes internally call
# `client.user_id()` to build the X-side conversation_id
# (`f"{partner_id}-{my_user_id}"`). twikit caches `_user_id` after the
# first hit, so this is effectively free after warmup.
# ---------------------------------------------------------------------------

@twitter.router.post("/users/{user_id}/dms")
async def tool_send_dm(user_id: str, body: SendDMRequest, response: Response):
    """Send a 1:1 direct message to a user.

    Returns the newly-created `Message` (serialized via
    `message_to_dict`). twikit's `send_dm` builds the conversation_id
    internally from the recipient id and the bot's own user id, so
    only the recipient + text are required.
    """
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        kwargs: dict = {}
        if body.media_id:
            kwargs["media_id"] = body.media_id
        if body.reply_to:
            kwargs["reply_to"] = body.reply_to
        return await client.send_dm(user_id, body.text, **kwargs)

    res = await _gate.execute(
        endpoint="send_dm",
        op=op,
        serializer=serializers.message_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.get("/users/{user_id}/dms")
async def tool_get_dm_history(
    response: Response,
    user_id: str,
    max_id: Optional[str] = None,
):
    """Page through 1:1 DM history with a given user.

    `max_id` paginates — pass back the oldest message id from a prior
    page to get older messages. twikit returns a `Result[Message]`
    that the serializer flattens into `{items, next_cursor,
    previous_cursor}`.
    """
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.get_dm_history(user_id, max_id)

    def serialize(result):
        return serializers.result_to_dict(result, serializers.message_to_dict)

    res = await _gate.execute(
        endpoint="dm_conversation",
        op=op,
        serializer=serialize,
        cache_key=("dm_history", user_id, max_id or ""),
        cache_ttl=_CACHE_TTLS["dm_conversation"],
    )
    return _gate_result_to_response(res, response)


@twitter.router.delete("/dms/{message_id}")
async def tool_delete_dm(message_id: str, response: Response):
    """Delete one of the authenticated account's own DMs.

    X only lets you delete DMs you sent; other-party deletes return a
    twikit exception that the gate maps to a 502. The success response
    is the canonical `{ok, status}` from `response_to_dict`.
    """
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.delete_dm(message_id)

    res = await _gate.execute(
        endpoint="delete_dm",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.post("/dms/{message_id}/reaction")
async def tool_add_dm_reaction(
    message_id: str,
    body: AddDMReactionRequest,
    response: Response,
):
    """Add an emoji reaction to a 1:1 DM.

    Builds the conversation_id (`f"{partner_id}-{my_user_id}"`) from
    the caller-supplied `partner_id` (the *other* user) and the bot's
    own id, then forwards to twikit's `add_reaction_to_message`. See
    `twikit/message.py::Message.add_reaction` for the same formula.
    """
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        me = await client.user_id()
        conv_id = f"{body.partner_id}-{me}"
        return await client.add_reaction_to_message(message_id, conv_id, body.emoji)

    res = await _gate.execute(
        endpoint="add_reaction_to_message",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.delete("/dms/{message_id}/reaction")
async def tool_remove_dm_reaction(
    response: Response,
    message_id: str,
    partner_id: str = Query(..., min_length=1),
    emoji: str = Query(..., min_length=1),
):
    """Remove an emoji reaction from a 1:1 DM.

    Mirror of `tool_add_dm_reaction`. `partner_id` and `emoji` are
    query params because DELETE bodies are spec-fuzzy across HTTP
    clients — keeping them in the query string matches the rest of
    the SubApp's DELETE routes.
    """
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        me = await client.user_id()
        conv_id = f"{partner_id}-{me}"
        return await client.remove_reaction_from_message(message_id, conv_id, emoji)

    res = await _gate.execute(
        endpoint="remove_reaction_from_message",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


# ---------------------------------------------------------------------------
# Group DMs
#
# Same gate/cache discipline as 1:1 DMs. Group reactions use the
# group_id as the conversation_id directly — no `user_id()` lookup
# needed.
# ---------------------------------------------------------------------------

@twitter.router.post("/groups/{group_id}/dms")
async def tool_send_group_dm(
    group_id: str,
    body: SendDMRequest,
    response: Response,
):
    """Send a DM into an existing group conversation."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        kwargs: dict = {}
        if body.media_id:
            kwargs["media_id"] = body.media_id
        if body.reply_to:
            kwargs["reply_to"] = body.reply_to
        return await client.send_dm_to_group(group_id, body.text, **kwargs)

    res = await _gate.execute(
        endpoint="send_dm",
        op=op,
        serializer=serializers.message_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.get("/groups/{group_id}/dms")
async def tool_get_group_dm_history(
    response: Response,
    group_id: str,
    max_id: Optional[str] = None,
):
    """Page through a group conversation's message history."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.get_group_dm_history(group_id, max_id)

    def serialize(result):
        return serializers.result_to_dict(result, serializers.message_to_dict)

    res = await _gate.execute(
        endpoint="dm_conversation",
        op=op,
        serializer=serialize,
        cache_key=("group_dm_history", group_id, max_id or ""),
        cache_ttl=_CACHE_TTLS["dm_conversation"],
    )
    return _gate_result_to_response(res, response)


@twitter.router.get("/groups/{group_id}")
async def tool_get_group(response: Response, group_id: str):
    """Fetch group metadata (name + members)."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.get_group(group_id)

    res = await _gate.execute(
        endpoint="get_group",
        op=op,
        serializer=serializers.group_to_dict,
        cache_key=("group", group_id),
        cache_ttl=_CACHE_TTLS["get_group"],
    )
    return _gate_result_to_response(res, response)


@twitter.router.post("/groups/{group_id}/members")
async def tool_add_group_members(
    group_id: str,
    body: AddGroupMembersRequest,
    response: Response,
):
    """Add one or more users to a group conversation by numeric id."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.add_members_to_group(group_id, body.user_ids)

    res = await _gate.execute(
        endpoint="add_members_to_group",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.patch("/groups/{group_id}/name")
async def tool_change_group_name(
    group_id: str,
    body: ChangeGroupNameRequest,
    response: Response,
):
    """Rename a group conversation."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.change_group_name(group_id, body.name)

    res = await _gate.execute(
        endpoint="change_group_name",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.post("/groups/{group_id}/messages/{message_id}/reaction")
async def tool_add_group_reaction(
    group_id: str,
    message_id: str,
    body: AddGroupReactionRequest,
    response: Response,
):
    """Add an emoji reaction to a message in a group conversation.

    For group DMs the conversation_id passed to twikit is the
    `group_id` itself (no partner-id flip needed).
    """
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.add_reaction_to_message(message_id, group_id, body.emoji)

    res = await _gate.execute(
        endpoint="add_reaction_to_message",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
    )
    return _gate_result_to_response(res, response)


@twitter.router.delete("/groups/{group_id}/messages/{message_id}/reaction")
async def tool_remove_group_reaction(
    response: Response,
    group_id: str,
    message_id: str,
    emoji: str = Query(..., min_length=1),
):
    """Remove an emoji reaction from a message in a group conversation."""
    _require_started()
    if _gate is None:
        raise HTTPException(503, "Twitter SubApp not ready")

    async def op(client):
        return await client.remove_reaction_from_message(message_id, group_id, emoji)

    res = await _gate.execute(
        endpoint="remove_reaction_from_message",
        op=op,
        serializer=serializers.response_to_dict,
        writable=True,
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
