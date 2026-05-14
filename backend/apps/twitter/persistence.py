"""On-disk state for the Twitter SubApp.

Everything durable lives under `DATA_ROOT/twitter/`:

  twitter/
    accounts.json         — account index (id, label, role, state, trust)
    cookies/<id>.json     — twikit cookie jar per account, mode 0600
    state.sqlite          — buckets, response cache, 429 audit log

`accounts.json` is a small, human-editable file. The cookies dir is the
sensitive bit — we make the dir mode 0700 and each file mode 0600 (twikit
itself writes the JSON, so we chmod after). The sqlite file holds the
high-churn state that benefits from indexed lookups and atomic
transactions.

This module knows nothing about twikit — it speaks only in plain dicts
and Bucket snapshots. The pool layer composes these primitives with
twikit.Client instances.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import time

from backend.config.paths import TWITTER_DIR

logger = logging.getLogger(__name__)

ACCOUNTS_PATH = os.path.join(TWITTER_DIR, "accounts.json")
COOKIES_DIR = os.path.join(TWITTER_DIR, "cookies")
STATE_DB_PATH = os.path.join(TWITTER_DIR, "state.sqlite")


# ---------------------------------------------------------------------------
# Filesystem setup
# ---------------------------------------------------------------------------

def ensure_dirs() -> None:
    """Create the twitter data dirs with restrictive permissions.

    Cookies are auth material — equivalent to bearer tokens for the
    user's X session. The dir is mode 0700 so other local users on a
    multi-user macOS box can't read them. (On single-user laptops this
    is belt-and-suspenders, but free.)
    """
    os.makedirs(TWITTER_DIR, exist_ok=True)
    os.makedirs(COOKIES_DIR, exist_ok=True)
    try:
        os.chmod(COOKIES_DIR, 0o700)
    except OSError as e:
        logger.warning("twitter: chmod 0700 on cookies dir failed: %s", e)


def cookies_path(account_id: str) -> str:
    return os.path.join(COOKIES_DIR, f"{account_id}.json")


def chmod_cookies(path: str) -> None:
    """Lock down a cookies file to mode 0600 (twikit writes it 0644)."""
    try:
        os.chmod(path, 0o600)
    except OSError as e:
        logger.warning("twitter: chmod 0600 on %s failed: %s", path, e)


def delete_cookies(account_id: str) -> None:
    path = cookies_path(account_id)
    if os.path.exists(path):
        try:
            os.remove(path)
        except OSError as e:
            logger.warning("twitter: rm %s failed: %s", path, e)


# ---------------------------------------------------------------------------
# accounts.json (small enough to load whole on every read)
# ---------------------------------------------------------------------------

def load_accounts() -> list[dict]:
    """Return the list of account records, empty list on first run."""
    if not os.path.isfile(ACCOUNTS_PATH):
        return []
    try:
        with open(ACCOUNTS_PATH) as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
        logger.warning("twitter: accounts.json wasn't a list, ignoring")
        return []
    except (OSError, json.JSONDecodeError) as e:
        logger.exception("twitter: accounts.json read failed: %s", e)
        return []


def save_accounts(accounts: list[dict]) -> None:
    """Atomic write so a crash mid-rename can't leave us with an empty file."""
    ensure_dirs()
    tmp = ACCOUNTS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(accounts, f, indent=2, default=str)
    os.replace(tmp, ACCOUNTS_PATH)


# ---------------------------------------------------------------------------
# state.sqlite — buckets, cache, audit
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS twitter_buckets (
    account_id TEXT NOT NULL,
    endpoint   TEXT NOT NULL,
    capacity   INTEGER NOT NULL,
    tokens     REAL NOT NULL,
    locked_until REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL,
    PRIMARY KEY (account_id, endpoint)
);

CREATE TABLE IF NOT EXISTS twitter_cache (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    expires_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_twitter_cache_expires_at
    ON twitter_cache (expires_at);

CREATE TABLE IF NOT EXISTS twitter_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         REAL NOT NULL,
    account_id TEXT NOT NULL,
    endpoint   TEXT NOT NULL,
    event      TEXT NOT NULL,
    detail     TEXT
);

CREATE INDEX IF NOT EXISTS idx_twitter_audit_ts
    ON twitter_audit (ts);
"""


def open_state_db() -> sqlite3.Connection:
    """Open the state sqlite, applying schema migrations if needed.

    WAL mode means concurrent readers don't block the snapshot writer,
    which we want because the route handlers read from `twitter_cache`
    on every call while the lifespan task is also writing bucket
    snapshots.

    Why `execute(...).fetchone()` for the PRAGMAs instead of
    `executescript`: `PRAGMA journal_mode=WAL` is a query that *returns
    a row* (the new mode), and `executescript` ignores result rows.
    On some sqlite builds that's enough for the pragma to silently
    not apply — using execute() + fetchone() forces the driver to
    actually run it and consume the result.

    `check_same_thread=False` is kept because the backend currently
    only touches sqlite from the asyncio event loop (single thread),
    but `TTLCache` defensively uses a `threading.Lock` in case
    something later offloads to a threadpool. If you add a sync
    sqlite call from a worker thread, share that lock.
    """
    ensure_dirs()
    conn = sqlite3.connect(STATE_DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL").fetchone()
    conn.execute("PRAGMA synchronous=NORMAL").fetchone()
    conn.executescript(_SCHEMA)
    conn.commit()
    try:
        os.chmod(STATE_DB_PATH, 0o600)
    except OSError:
        pass
    return conn


# ---------------------------------------------------------------------------
# Bucket snapshot read/write
# ---------------------------------------------------------------------------

def load_buckets(conn: sqlite3.Connection, account_id: str) -> dict[str, dict]:
    """Return {endpoint: snapshot_dict} for one account.

    Snapshot dict matches `Bucket.snapshot()` keys (capacity, tokens,
    locked_until) so the pool can call `Bucket.restore(snap)` directly.
    """
    cur = conn.execute(
        "SELECT endpoint, capacity, tokens, locked_until "
        "FROM twitter_buckets WHERE account_id = ?",
        (account_id,),
    )
    out: dict[str, dict] = {}
    for endpoint, capacity, tokens, locked_until in cur.fetchall():
        out[endpoint] = {
            "capacity": int(capacity),
            "tokens": float(tokens),
            "locked_until": float(locked_until),
        }
    return out


def save_bucket(
    conn: sqlite3.Connection,
    account_id: str,
    endpoint: str,
    snapshot: dict,
) -> None:
    """Upsert one bucket. Called by the periodic snapshot loop, ~1Hz."""
    conn.execute(
        """
        INSERT INTO twitter_buckets
            (account_id, endpoint, capacity, tokens, locked_until, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, endpoint) DO UPDATE SET
            capacity = excluded.capacity,
            tokens = excluded.tokens,
            locked_until = excluded.locked_until,
            updated_at = excluded.updated_at
        """,
        (
            account_id,
            endpoint,
            int(snapshot.get("capacity", 1)),
            float(snapshot.get("tokens", 0.0)),
            float(snapshot.get("locked_until", 0.0)),
            time.time(),
        ),
    )


def delete_buckets_for(conn: sqlite3.Connection, account_id: str) -> None:
    """Drop all bucket rows for an account (called on account delete)."""
    conn.execute("DELETE FROM twitter_buckets WHERE account_id = ?", (account_id,))
    conn.commit()


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

def audit(
    conn: sqlite3.Connection,
    account_id: str,
    endpoint: str,
    event: str,
    detail: str | None = None,
) -> None:
    """Append a row to the audit log. Cheap (no commit per-row in WAL).

    Events worth logging: `429`, `locked`, `suspended`, `login_ok`,
    `login_fail`, `verify_ok`, `verify_fail`, `relogin`, `delete`.
    The route layer keys off these when computing /health summaries.
    """
    conn.execute(
        "INSERT INTO twitter_audit (ts, account_id, endpoint, event, detail) "
        "VALUES (?, ?, ?, ?, ?)",
        (time.time(), account_id, endpoint, event, detail),
    )


def recent_429s(conn: sqlite3.Connection, account_id: str, since_s: float) -> int:
    """How many 429 events did this account hit since `since_s` seconds ago?

    Surfaced via the /health endpoint so the operator can see whether
    the trust_multiplier needs to come down.
    """
    cutoff = time.time() - since_s
    row = conn.execute(
        "SELECT COUNT(*) FROM twitter_audit "
        "WHERE account_id = ? AND event = '429' AND ts >= ?",
        (account_id, cutoff),
    ).fetchone()
    return int(row[0])


def trim_audit(conn: sqlite3.Connection, keep_days: int = 30) -> None:
    """Drop audit rows older than `keep_days`. Called on lifespan startup.

    Audit data is purely for human inspection / health UI — nobody
    depends on the full history. Keep it bounded so the sqlite file
    doesn't drift toward "the size of the disk."
    """
    cutoff = time.time() - keep_days * 86400
    conn.execute("DELETE FROM twitter_audit WHERE ts < ?", (cutoff,))
    conn.commit()
