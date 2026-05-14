"""Persistence-layer tests for the Twitter SubApp.

These exercise the small sqlite schema, accounts.json round-trip, and
the bucket-snapshot/restore path that's load-bearing for crash safety
(see `Bucket.restore` semantics).
"""

from __future__ import annotations

import json
import os
import tempfile

import pytest


@pytest.fixture
def tmp_twitter_dir(monkeypatch):
    """Re-point `TWITTER_DIR` at a tempdir so writes don't touch DATA_ROOT."""
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
        yield d


def test_ensure_dirs_creates_with_strict_modes(tmp_twitter_dir):
    from backend.apps.twitter.persistence import COOKIES_DIR, ensure_dirs

    ensure_dirs()
    assert os.path.isdir(tmp_twitter_dir)
    assert os.path.isdir(COOKIES_DIR)
    # On macOS / Linux, mode 0700 means user-only access.
    mode = os.stat(COOKIES_DIR).st_mode & 0o777
    assert mode == 0o700, f"expected 0700, got {oct(mode)}"


def test_accounts_round_trip(tmp_twitter_dir):
    from backend.apps.twitter.persistence import load_accounts, save_accounts

    assert load_accounts() == []
    save_accounts([{"id": "a1", "label": "main"}])
    loaded = load_accounts()
    assert loaded == [{"id": "a1", "label": "main"}]


def test_accounts_missing_file_returns_empty(tmp_twitter_dir):
    from backend.apps.twitter.persistence import load_accounts

    assert load_accounts() == []


def test_accounts_atomic_write_replaces_tmp(tmp_twitter_dir):
    """save_accounts writes via a tmp file + os.replace; tmp shouldn't linger."""
    from backend.apps.twitter.persistence import ACCOUNTS_PATH, save_accounts

    save_accounts([{"id": "x"}])
    tmp = ACCOUNTS_PATH + ".tmp"
    assert not os.path.exists(tmp)
    assert os.path.isfile(ACCOUNTS_PATH)


def test_open_state_db_creates_schema(tmp_twitter_dir):
    from backend.apps.twitter.persistence import open_state_db

    conn = open_state_db()
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    assert {"twitter_buckets", "twitter_cache", "twitter_audit"} <= tables


def test_save_load_bucket_round_trip(tmp_twitter_dir):
    from backend.apps.twitter.persistence import load_buckets, open_state_db, save_bucket

    conn = open_state_db()
    save_bucket(
        conn,
        account_id="a1",
        endpoint="search_tweet",
        snapshot={"capacity": 50, "tokens": 17.5, "locked_until": 12345.0},
    )
    conn.commit()
    rows = load_buckets(conn, "a1")
    assert rows == {
        "search_tweet": {"capacity": 50, "tokens": 17.5, "locked_until": 12345.0}
    }


def test_save_bucket_upserts_on_conflict(tmp_twitter_dir):
    """Re-saving the same (account, endpoint) updates in place."""
    from backend.apps.twitter.persistence import load_buckets, open_state_db, save_bucket

    conn = open_state_db()
    save_bucket(conn, "a1", "search_tweet", {"capacity": 50, "tokens": 50.0, "locked_until": 0})
    save_bucket(conn, "a1", "search_tweet", {"capacity": 50, "tokens": 3.0, "locked_until": 999})
    conn.commit()
    rows = load_buckets(conn, "a1")
    assert rows["search_tweet"]["tokens"] == pytest.approx(3.0)
    assert rows["search_tweet"]["locked_until"] == pytest.approx(999.0)
    # And only one row, not two.
    (n,) = conn.execute("SELECT COUNT(*) FROM twitter_buckets WHERE account_id='a1'").fetchone()
    assert n == 1


def test_delete_buckets_for(tmp_twitter_dir):
    from backend.apps.twitter.persistence import delete_buckets_for, open_state_db, save_bucket

    conn = open_state_db()
    save_bucket(conn, "a1", "search_tweet", {"capacity": 50, "tokens": 50.0, "locked_until": 0})
    save_bucket(conn, "a2", "search_tweet", {"capacity": 50, "tokens": 50.0, "locked_until": 0})
    delete_buckets_for(conn, "a1")
    (n_a1,) = conn.execute("SELECT COUNT(*) FROM twitter_buckets WHERE account_id='a1'").fetchone()
    (n_a2,) = conn.execute("SELECT COUNT(*) FROM twitter_buckets WHERE account_id='a2'").fetchone()
    assert n_a1 == 0
    assert n_a2 == 1


def test_audit_and_recent_429s(tmp_twitter_dir):
    from backend.apps.twitter.persistence import audit, open_state_db, recent_429s

    conn = open_state_db()
    audit(conn, "a1", "search_tweet", "429", "rate limit")
    audit(conn, "a1", "search_tweet", "429", "rate limit")
    audit(conn, "a1", "search_tweet", "login_ok", None)
    conn.commit()
    assert recent_429s(conn, "a1", since_s=3600) == 2
    assert recent_429s(conn, "a2", since_s=3600) == 0


def test_trim_audit_drops_old(tmp_twitter_dir, monkeypatch):
    import time
    from backend.apps.twitter.persistence import audit, open_state_db, trim_audit

    conn = open_state_db()
    # Insert a row 60 days in the past (default keep_days=30 should drop).
    old_ts = time.time() - 60 * 86400
    conn.execute(
        "INSERT INTO twitter_audit (ts, account_id, endpoint, event, detail) "
        "VALUES (?, 'a1', 'x', 'login_ok', NULL)",
        (old_ts,),
    )
    audit(conn, "a1", "x", "login_ok")  # fresh
    conn.commit()
    trim_audit(conn, keep_days=30)
    (n,) = conn.execute("SELECT COUNT(*) FROM twitter_audit").fetchone()
    assert n == 1


def test_cookies_path_and_chmod(tmp_twitter_dir):
    from backend.apps.twitter.persistence import (
        chmod_cookies,
        cookies_path,
        ensure_dirs,
    )

    ensure_dirs()
    p = cookies_path("acct-uuid-1")
    # Simulate twikit having written cookies with default mode.
    with open(p, "w") as f:
        json.dump({"auth_token": "x", "ct0": "y"}, f)
    os.chmod(p, 0o644)
    chmod_cookies(p)
    mode = os.stat(p).st_mode & 0o777
    assert mode == 0o600


def test_delete_cookies_is_idempotent(tmp_twitter_dir):
    from backend.apps.twitter.persistence import delete_cookies, ensure_dirs, cookies_path

    ensure_dirs()
    # No-op when file doesn't exist.
    delete_cookies("never-existed")
    # Create then delete.
    p = cookies_path("acct1")
    with open(p, "w") as f:
        f.write("{}")
    assert os.path.isfile(p)
    delete_cookies("acct1")
    assert not os.path.exists(p)
