"""Bounded SQLite spool for offline operational submissions.

When the desktop is offline (laptop closed, no internet, cloud unreachable),
the service-sync layer can't reach `api.openswarm.com`. Rather than drop
data on the floor, we spool submissions to a small SQLite file and replay
them on the next online tick. The spool is bounded — when full, the oldest
entries are dropped — so it can never balloon to a problem.

Single file, single table, single thread guarded by a sqlite3 connection's
implicit lock. No concurrency model beyond "don't write from two processes
at once."
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
from contextlib import contextmanager
from typing import Iterator, Optional

logger = logging.getLogger(__name__)

# Cap the spool at 50 MB on disk. SQLite's overhead means the actual ceiling
# on retained payloads is somewhat smaller, which is fine — this is a
# best-effort cushion, not a guaranteed retention window.
_MAX_BYTES = 50 * 1024 * 1024

# Trim 25% when we cross the cap so we don't trim on every insert.
_TRIM_TARGET_FRACTION = 0.75

_lock = threading.Lock()


@contextmanager
def _conn(spool_path: str) -> Iterator[sqlite3.Connection]:
    """Open a connection that auto-commits and ensures the table exists.
    Caller holds `_lock` for the duration of the context."""
    os.makedirs(os.path.dirname(spool_path), exist_ok=True)
    c = sqlite3.connect(spool_path, isolation_level=None, timeout=5.0)
    try:
        c.execute(
            "CREATE TABLE IF NOT EXISTS spool ("
            "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  kind TEXT NOT NULL,"
            "  payload TEXT NOT NULL,"
            "  created_at REAL NOT NULL"
            ")"
        )
        yield c
    finally:
        c.close()


def enqueue(spool_path: str, kind: str, payload: dict, *, now: float) -> None:
    """Append a submission to the spool. Drops the oldest if the spool is
    over the byte cap."""
    body = json.dumps(payload, separators=(",", ":"), default=str)
    with _lock, _conn(spool_path) as c:
        c.execute(
            "INSERT INTO spool (kind, payload, created_at) VALUES (?, ?, ?)",
            (kind, body, now),
        )
        # Cheap size check — only run trim when stat says we're over.
        try:
            size = os.path.getsize(spool_path)
        except OSError:
            size = 0
        if size > _MAX_BYTES:
            target = int(_MAX_BYTES * _TRIM_TARGET_FRACTION)
            # Delete oldest rows until we're back under target. Use a
            # reasonable batch size so we don't block forever.
            for _ in range(64):
                row = c.execute("SELECT id FROM spool ORDER BY id ASC LIMIT 1").fetchone()
                if not row:
                    break
                c.execute("DELETE FROM spool WHERE id = ?", (row[0],))
                try:
                    new_size = os.path.getsize(spool_path)
                except OSError:
                    new_size = 0
                if new_size <= target:
                    break
            # VACUUM is expensive; only run if we still appear oversized after
            # trimming, otherwise free pages get reused on next insert.
            try:
                if os.path.getsize(spool_path) > _MAX_BYTES:
                    c.execute("VACUUM")
            except (OSError, sqlite3.DatabaseError):
                pass


def drain(spool_path: str, batch_size: int = 50) -> list[tuple[int, str, dict]]:
    """Read up to `batch_size` oldest entries. Returns (id, kind, payload)
    triples; caller is responsible for calling `acknowledge(ids)` once the
    cloud accepts them."""
    if not os.path.exists(spool_path):
        return []
    with _lock, _conn(spool_path) as c:
        rows = c.execute(
            "SELECT id, kind, payload FROM spool ORDER BY id ASC LIMIT ?",
            (batch_size,),
        ).fetchall()
    out: list[tuple[int, str, dict]] = []
    for rid, kind, body in rows:
        try:
            out.append((rid, kind, json.loads(body)))
        except json.JSONDecodeError:
            # Corrupt row — discard so it doesn't block draining behind it.
            with _lock, _conn(spool_path) as c:
                c.execute("DELETE FROM spool WHERE id = ?", (rid,))
            logger.warning("Dropped corrupt spool row id=%s", rid)
    return out


def acknowledge(spool_path: str, ids: list[int]) -> None:
    """Remove rows the cloud has accepted."""
    if not ids:
        return
    with _lock, _conn(spool_path) as c:
        c.executemany("DELETE FROM spool WHERE id = ?", [(i,) for i in ids])


def count(spool_path: str) -> int:
    """Return the number of pending entries. Used for tests + debug UI."""
    if not os.path.exists(spool_path):
        return 0
    with _lock, _conn(spool_path) as c:
        row = c.execute("SELECT COUNT(*) FROM spool").fetchone()
    return int(row[0]) if row else 0


def clear(spool_path: str) -> None:
    """Delete all pending entries. Tests + manual reset only."""
    with _lock, _conn(spool_path) as c:
        c.execute("DELETE FROM spool")
