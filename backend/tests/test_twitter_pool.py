"""AccountPool tests: pick ordering, add/remove lifecycle, error hooks.

No twikit needed — we feed in a sentinel object as the "client" since
the pool itself never calls twikit (RateGate does).
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest


@pytest.fixture
def tmp_state_db(monkeypatch):
    """Isolated sqlite + accounts dir per test."""
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
        from backend.apps.twitter.persistence import open_state_db
        conn = open_state_db()
        yield conn
        conn.close()


def _make_pool(conn):
    from backend.apps.twitter.pool import AccountPool
    return AccountPool(conn)


def _make_record(id_="a1", state="active", role="primary", trust=0.4, handle=None):
    from backend.apps.twitter.models import TwitterAccount
    return TwitterAccount(id=id_, state=state, role=role, trust_multiplier=trust, handle=handle)


# ---------------------------------------------------------------------------
# pick()
# ---------------------------------------------------------------------------

def test_pick_empty_returns_none(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        return await pool.pick("search_tweet")

    assert asyncio.run(_run()) is None


def test_pick_skips_non_active_accounts(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1", state="locked"), object())
        await pool.add(_make_record("a2", state="suspended"), object())
        return await pool.pick("search_tweet")

    assert asyncio.run(_run()) is None


def test_pick_returns_active(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1", state="locked"), object())
        await pool.add(_make_record("a2", state="active"), object())
        chosen = await pool.pick("search_tweet")
        return chosen.id

    assert asyncio.run(_run()) == "a2"


def test_pick_prefers_account_with_more_budget(tmp_state_db, monkeypatch):
    """Two active accounts: the one whose bucket is unlocked wins."""
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("hot"), object())
        await pool.add(_make_record("cold"), object())

        # Drain the "hot" account's bucket to force a long wait.
        hot = pool.get("hot")
        b = hot.bucket("search_tweet")
        b.tokens = 0.0
        import time as t
        b.locked_until = t.time() + 999  # blocked for a long time

        chosen = await pool.pick("search_tweet")
        return chosen.id

    assert asyncio.run(_run()) == "cold"


# ---------------------------------------------------------------------------
# pick_writable() — only role="primary" accounts are eligible for writes
# ---------------------------------------------------------------------------

def test_pick_writable_empty_returns_none(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        return await pool.pick_writable("create_tweet")

    assert asyncio.run(_run()) is None


def test_pick_writable_excludes_read_only(tmp_state_db):
    """Pool with a primary + a read_only: writable picker returns primary."""
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("ro", role="read_only"), object())
        await pool.add(_make_record("pri", role="primary"), object())
        chosen = await pool.pick_writable("create_tweet")
        return chosen.id

    assert asyncio.run(_run()) == "pri"


def test_pick_writable_returns_none_when_only_read_only(tmp_state_db):
    """If every account is read_only, writes have no home."""
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("ro1", role="read_only"), object())
        await pool.add(_make_record("ro2", role="read_only"), object())
        return await pool.pick_writable("create_tweet")

    assert asyncio.run(_run()) is None


def test_pick_writable_skips_non_active_primaries(tmp_state_db):
    """`role=primary` + `state=needs_relogin` is still ineligible.

    `pick_writable` keeps both the read/`pick()` invariants — never
    return removing-in-progress or non-active accounts — and adds the
    role filter. A "broken" primary doesn't downgrade to writable.
    """
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("pri_locked", role="primary", state="locked"), object())
        await pool.add(_make_record("pri_relogin", role="primary", state="needs_relogin"), object())
        return await pool.pick_writable("create_tweet")

    assert asyncio.run(_run()) is None


def test_pick_writable_prefers_account_with_more_budget(tmp_state_db):
    """Two writable primaries: the one with more bucket budget wins.

    Same ordering rule as `pick()` — the role filter is an additional
    filter, not a replacement for the budget-based tie-breaker.
    """
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("hot", role="primary"), object())
        await pool.add(_make_record("cold", role="primary"), object())

        hot = pool.get("hot")
        b = hot.bucket("create_tweet")
        b.tokens = 0.0
        import time as t
        b.locked_until = t.time() + 999

        chosen = await pool.pick_writable("create_tweet")
        return chosen.id

    assert asyncio.run(_run()) == "cold"


# ---------------------------------------------------------------------------
# add() — runtime registration
# ---------------------------------------------------------------------------

def test_add_inserts_with_buckets_lazy(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        managed = await pool.add(_make_record("a1"), object())
        # No bucket created until requested.
        assert managed._buckets == {}
        b = managed.bucket("search_tweet")
        # Trust 0.4 * 50 default = 20.
        assert b.capacity == 20

    asyncio.run(_run())


def test_add_idempotent_for_relogin(tmp_state_db):
    """Re-login: same account.id, same handle — must reuse the existing
    ManagedAccount (so we don't lose bucket state on a cookie refresh)."""
    async def _run():
        pool = _make_pool(tmp_state_db)
        first = await pool.add(_make_record("a1"), object())
        # Consume some budget so we can verify it survives the re-add.
        b = first.bucket("search_tweet")
        b.tokens = 3.0
        new_client = object()
        second = await pool.add(_make_record("a1"), new_client)
        assert second is first, "must mutate in place, not replace"
        assert second.client is new_client
        assert second.bucket("search_tweet").tokens == pytest.approx(3.0)

    asyncio.run(_run())


def test_add_restores_buckets_from_disk(tmp_state_db):
    """Snapshot persisted from a previous run gets restored on add()."""
    from backend.apps.twitter.persistence import save_bucket

    save_bucket(
        tmp_state_db,
        account_id="a1",
        endpoint="search_tweet",
        snapshot={"capacity": 20, "tokens": 4.0, "locked_until": 1234.0},
    )
    tmp_state_db.commit()

    async def _run():
        pool = _make_pool(tmp_state_db)
        managed = await pool.add(_make_record("a1"), object())
        b = managed.bucket("search_tweet")
        # restore() clamps to capacity / 2 = 10, and 4 < 10 so kept at 4.
        assert b.tokens == pytest.approx(4.0)
        assert b.locked_until == pytest.approx(1234.0)

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# remove() — cancellation safety
# ---------------------------------------------------------------------------

def test_remove_clean_path(tmp_state_db):
    """No in-flight call: remove() returns True immediately."""
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1"), object())
        # Touch a bucket so we have something to clean up.
        pool.get("a1").bucket("search_tweet")
        pool.snapshot_all()
        result = await pool.remove("a1")
        return result, pool.get("a1")

    clean, after = asyncio.run(_run())
    assert clean is True
    assert after is None


def test_remove_missing_account_is_noop(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        return await pool.remove("never-existed")

    assert asyncio.run(_run()) is True


def test_remove_waits_for_in_flight_call(tmp_state_db, monkeypatch):
    """If a call is mid-flight under the semaphore, remove() should wait."""

    async def _run():
        from backend.apps.twitter.pool import AccountPool
        pool = AccountPool(tmp_state_db)
        await pool.add(_make_record("a1"), object())
        managed = pool.get("a1")

        # Manually take the semaphore as if a twikit call were running.
        await managed.concurrency.acquire()

        async def _release_later():
            await asyncio.sleep(0.05)
            managed.concurrency.release()

        rel = asyncio.create_task(_release_later())
        clean = await pool.remove("a1")
        await rel
        return clean

    assert asyncio.run(_run()) is True


def test_remove_timeout_returns_false(tmp_state_db, monkeypatch):
    """If the in-flight call doesn't yield within REMOVE_TIMEOUT_S, we
    bail and let the caller route a 503."""
    monkeypatch.setattr("backend.apps.twitter.pool.REMOVE_TIMEOUT_S", 0.05)

    async def _run():
        from backend.apps.twitter.pool import AccountPool
        pool = AccountPool(tmp_state_db)
        await pool.add(_make_record("a1"), object())
        managed = pool.get("a1")
        # Hold the semaphore for longer than the timeout.
        await managed.concurrency.acquire()
        clean = await pool.remove("a1")
        managed.concurrency.release()
        return clean

    assert asyncio.run(_run()) is False


def test_remove_wipes_buckets_from_disk(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1"), object())
        pool.get("a1").bucket("search_tweet")
        pool.snapshot_all()
        # Sanity: bucket row exists.
        (n_before,) = tmp_state_db.execute(
            "SELECT COUNT(*) FROM twitter_buckets WHERE account_id='a1'"
        ).fetchone()
        assert n_before == 1

        await pool.remove("a1")
        (n_after,) = tmp_state_db.execute(
            "SELECT COUNT(*) FROM twitter_buckets WHERE account_id='a1'"
        ).fetchone()
        assert n_after == 0

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# lifecycle hooks
# ---------------------------------------------------------------------------

def test_mark_locked_flips_state_and_audits(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1"), object())
        pool.mark_locked("a1", "arkose")
        tmp_state_db.commit()
        acct = pool.get("a1")
        return acct.state, acct.record.last_error

    state, err = asyncio.run(_run())
    assert state == "locked"
    assert "arkose" in (err or "")
    # And an audit row was written.
    (n,) = tmp_state_db.execute(
        "SELECT COUNT(*) FROM twitter_audit WHERE account_id='a1' AND event='locked'"
    ).fetchone()
    assert n == 1


def test_mark_suspended_routes_correctly(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1"), object())
        pool.mark_suspended("a1", "policy violation")
        return pool.get("a1").state

    assert asyncio.run(_run()) == "suspended"


def test_mark_needs_relogin_routes_correctly(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1"), object())
        pool.mark_needs_relogin("a1", "401")
        return pool.get("a1").state

    assert asyncio.run(_run()) == "needs_relogin"


def test_mark_active_after_recovery(tmp_state_db):
    """A locked account that re-logins successfully goes back to active."""
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1", state="locked"), object())
        pool.mark_active("a1")
        acct = pool.get("a1")
        return acct.state, acct.record.last_error, acct.record.last_verified_at > 0

    state, err, verified = asyncio.run(_run())
    assert state == "active"
    assert err is None
    assert verified is True


# ---------------------------------------------------------------------------
# rescale_buckets (PATCH /accounts/{id} support)
# ---------------------------------------------------------------------------

def test_rescale_buckets_lowers_cap_and_clamps_tokens(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1", trust=0.4), object())
        managed = pool.get("a1")
        b = managed.bucket("search_tweet")
        assert b.capacity == 20
        b.tokens = 18.0

        # Halve the multiplier — new cap should be 10, and tokens
        # should be clamped down with it.
        managed.record.trust_multiplier = 0.2
        managed.rescale_buckets()
        b2 = managed.bucket("search_tweet")
        assert b2.capacity == 10
        assert b2.tokens <= 10

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# by_handle lookup (re-login path)
# ---------------------------------------------------------------------------

def test_by_handle_case_insensitive(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1", handle="OpenSwarm"), object())
        return pool.by_handle("@openswarm").id

    assert asyncio.run(_run()) == "a1"


def test_by_handle_missing_returns_none(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("a1", handle="X"), object())
        return pool.by_handle("Y")

    assert asyncio.run(_run()) is None


# ---------------------------------------------------------------------------
# Re-login client-swap: must drain in-flight calls
# ---------------------------------------------------------------------------

def test_add_waits_for_in_flight_call_on_relogin(tmp_state_db):
    """A second `add` on the same id swaps the Client. If a twikit call
    is mid-flight under the semaphore, the swap must wait — otherwise
    the in-flight call sees its cookies replaced halfway through.
    """

    async def _run():
        from backend.apps.twitter.pool import AccountPool
        pool = AccountPool(tmp_state_db)
        first_client = object()
        await pool.add(_make_record("a1"), first_client)
        managed = pool.get("a1")

        # Pretend a twikit call is in flight by taking the semaphore.
        await managed.concurrency.acquire()

        new_client = object()
        # Schedule a release shortly after we kick off `add`.
        async def _release_later():
            await asyncio.sleep(0.05)
            managed.concurrency.release()

        rel = asyncio.create_task(_release_later())
        result = await pool.add(_make_record("a1"), new_client)
        await rel

        # We got back the SAME ManagedAccount with the NEW client.
        assert result is managed
        assert result.client is new_client

    asyncio.run(_run())


def test_add_relogin_times_out_on_stuck_call(tmp_state_db, monkeypatch):
    """If the in-flight call never releases, the swap proceeds anyway.

    The alternative is stranding a re-login indefinitely on a stuck
    twikit call — much worse than a one-call cookie-drift surprise.
    """
    monkeypatch.setattr("backend.apps.twitter.pool.REPLACE_CLIENT_TIMEOUT_S", 0.05)

    async def _run():
        from backend.apps.twitter.pool import AccountPool
        pool = AccountPool(tmp_state_db)
        await pool.add(_make_record("a1"), object())
        managed = pool.get("a1")
        # Hold the semaphore for longer than the timeout.
        await managed.concurrency.acquire()

        new_client = object()
        result = await pool.add(_make_record("a1"), new_client)
        managed.concurrency.release()
        return result.client is new_client

    assert asyncio.run(_run()) is True


# ---------------------------------------------------------------------------
# audit/commit/recent_429s helpers (keep routes out of pool._conn)
# ---------------------------------------------------------------------------

def test_audit_lifecycle_writes_underscore_lifecycle_endpoint(tmp_state_db):
    async def _run():
        pool = _make_pool(tmp_state_db)
        pool.audit_lifecycle("a1", "delete", "user-requested")
        pool.commit()

    asyncio.run(_run())
    rows = tmp_state_db.execute(
        "SELECT endpoint, event, detail FROM twitter_audit WHERE account_id='a1'"
    ).fetchall()
    assert rows == [("_lifecycle", "delete", "user-requested")]


def test_recent_429s_helper_returns_audit_count(tmp_state_db):
    """pool.recent_429s wraps persistence.recent_429s so /health doesn't
    need to know about the sqlite connection."""

    async def _run():
        pool = _make_pool(tmp_state_db)
        pool.record_429("a1", "search_tweet")
        pool.record_429("a1", "search_tweet")
        pool.commit()
        return pool.recent_429s("a1", since_s=3600)

    assert asyncio.run(_run()) == 2


# ---------------------------------------------------------------------------
# dedupe_by_handle — invariant: one ManagedAccount per X identity
# ---------------------------------------------------------------------------

def test_dedupe_by_handle_removes_others(tmp_state_db):
    """Two entries share a handle; dedupe collapses to the keeper.

    Unrelated handles must be untouched. The loser's cookies file
    must be deleted from disk so a future hydrate pass can't re-load
    the stale entry.
    """
    from backend.apps.twitter import persistence as pers

    pers.ensure_dirs()

    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("keep", handle="alice"), object())
        await pool.add(_make_record("dup", handle="Alice"), object())  # case-insensitive
        await pool.add(_make_record("other", handle="bob"), object())

        # Cookies files for each, so we can verify cleanup.
        for aid in ("keep", "dup", "other"):
            with open(pers.cookies_path(aid), "w") as f:
                f.write("{}")

        removed = await pool.dedupe_by_handle("alice", keep_id="keep")
        return removed, [a.id for a in pool.accounts]

    removed, remaining = asyncio.run(_run())
    assert removed == ["dup"]
    assert sorted(remaining) == ["keep", "other"]

    from backend.apps.twitter import persistence as pers
    assert os.path.exists(pers.cookies_path("keep"))
    assert not os.path.exists(pers.cookies_path("dup"))
    assert os.path.exists(pers.cookies_path("other"))


def test_dedupe_by_handle_is_noop_when_unique(tmp_state_db):
    """Calling dedupe with only one matching handle removes nothing."""

    async def _run():
        pool = _make_pool(tmp_state_db)
        await pool.add(_make_record("only", handle="alice"), object())
        await pool.add(_make_record("other", handle="bob"), object())
        removed = await pool.dedupe_by_handle("alice", keep_id="only")
        return removed, [a.id for a in pool.accounts]

    removed, remaining = asyncio.run(_run())
    assert removed == []
    assert sorted(remaining) == ["only", "other"]


def test_hydrate_pool_collapses_same_handle_duplicates(tmp_state_db, monkeypatch):
    """Startup hydration deduplicates pre-existing same-handle entries.

    Simulates state left over from the pre-fix accounts_import (two
    accounts.json records with the same handle). After _hydrate_pool,
    only the canonical winner remains in the pool, the loser's
    cookies file is gone, and accounts.json is rewritten.
    """
    import json as _json
    from unittest.mock import MagicMock

    from backend.apps.twitter import persistence as pers
    from backend.apps.twitter import twitter as tw

    pers.ensure_dirs()

    # Two records with the same handle. "loser" is inactive + older
    # last_verified_at; the keeper sort prefers state=active first.
    accounts = [
        {
            "id": "loser",
            "label": "imported",
            "handle": "alice",
            "role": "primary",
            "state": "needs_relogin",
            "trust_multiplier": 0.4,
            "created_at": 1000.0,
            "last_verified_at": 0.0,
            "last_error": None,
        },
        {
            "id": "keeper",
            "label": "imported",
            "handle": "alice",
            "role": "primary",
            "state": "active",
            "trust_multiplier": 0.4,
            "created_at": 2000.0,
            "last_verified_at": 9999.0,
            "last_error": None,
        },
    ]
    pers.save_accounts(accounts)
    for aid in ("loser", "keeper"):
        with open(pers.cookies_path(aid), "w") as f:
            _json.dump({"auth_token": f"tok-{aid}", "ct0": f"ct0-{aid}"}, f)

    # Stub twikit.Client — _hydrate_pool constructs one per record.
    import twikit

    def _make_client(*_a, **_kw):
        c = MagicMock(name="twikit.Client")
        c.set_cookies = MagicMock()
        return c

    monkeypatch.setattr(twikit, "Client", _make_client)

    pool = _make_pool(tmp_state_db)
    asyncio.run(tw._hydrate_pool(pool))

    assert [a.id for a in pool.accounts] == ["keeper"]
    assert os.path.exists(pers.cookies_path("keeper"))
    assert not os.path.exists(pers.cookies_path("loser"))
    # accounts.json was rewritten with only the keeper.
    on_disk = pers.load_accounts()
    assert [a["id"] for a in on_disk] == ["keeper"]
