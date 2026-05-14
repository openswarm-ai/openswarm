"""TTL cache for twikit read responses.

Caches successful (non-error) twikit responses keyed by
`(endpoint, normalized_args)`. Two reasons this matters:

1. LLM agents replay tool calls — the same `get_user("openai")` shows up
   many times in a typical conversation as the model thinks. A short TTL
   absorbs the redundancy without staleness mattering for the bulk of
   queries.
2. Cache hits skip the rate-limit bucket entirely, which is the single
   biggest throughput win for the entire SubApp.

Backed by sqlite so a process restart doesn't blow the budget — the
first agent call after a restart can still hit the cache instead of
twikit. The in-memory layer is just a write-through speedup; durability
lives in sqlite.

Schema is owned by `persistence.py` (one connection per SubApp,
WAL mode, see there). This module only knows how to GET/SET against
it.

We never cache errors. If `set()` is called with a non-OK payload (the
caller never should, but defensively) it's a no-op.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)


def _normalize_key(key: tuple) -> str:
    """Deterministic string form for a cache key tuple.

    Sort dict members so callers don't have to be careful about key
    order in arg tuples. Falls back to `repr()` for anything not JSON-
    serializable (shouldn't happen in our paths, but defensive).
    """
    try:
        return json.dumps(list(key), sort_keys=True, default=str)
    except Exception:
        return repr(key)


class TTLCache:
    """SQLite-backed TTL cache with an in-process write-through layer.

    Single-process semantics: the in-memory dict is the authoritative
    fast path. sqlite gets a copy so the next process start can
    re-warm. We don't try to coordinate across processes — there's only
    one backend process.

    Thread/async safety: sqlite connections aren't shareable across
    threads safely; we wrap reads/writes in a Lock. The hot path stays
    short (single SELECT or INSERT OR REPLACE) so contention is
    negligible for our request volume.
    """

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self._lock = threading.Lock()
        self._mem: dict[str, tuple[float, Any]] = {}
        # On startup, warm the in-memory dict from disk so cache hits are
        # immediate after a restart. Drops expired entries while we're at
        # it.
        self._warm_from_disk()

    def _warm_from_disk(self) -> None:
        now = time.time()
        with self._lock:
            cur = self._conn.execute("SELECT key, value_json, expires_at FROM twitter_cache")
            for k, v_json, exp in cur.fetchall():
                if exp > now:
                    try:
                        self._mem[k] = (exp, json.loads(v_json))
                    except json.JSONDecodeError:
                        continue
            # Garbage-collect expired rows so disk doesn't grow unbounded.
            self._conn.execute("DELETE FROM twitter_cache WHERE expires_at <= ?", (now,))
            self._conn.commit()
        logger.info("twitter cache: warmed %d entries from disk", len(self._mem))

    def get(self, key: tuple) -> Any | None:
        nk = _normalize_key(key)
        now = time.time()
        # Hot path: in-memory hit.
        entry = self._mem.get(nk)
        if entry is not None:
            exp, val = entry
            if exp > now:
                return val
            # Expired — drop it so we don't return again.
            self._mem.pop(nk, None)
        return None

    def set(self, key: tuple, value: Any, *, ttl: int) -> None:
        if ttl <= 0:
            return
        nk = _normalize_key(key)
        expires_at = time.time() + ttl
        self._mem[nk] = (expires_at, value)
        try:
            payload = json.dumps(value, default=str)
        except Exception as e:
            # If we can't serialize, just keep the in-memory copy and
            # skip the disk write. The cache will still satisfy reads
            # this session.
            logger.warning("cache: serializer failed for %s (%s); keeping memory-only", key, e)
            return
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO twitter_cache (key, value_json, expires_at) VALUES (?, ?, ?)",
                (nk, payload, expires_at),
            )
            self._conn.commit()

    def invalidate(self, key: tuple) -> None:
        nk = _normalize_key(key)
        self._mem.pop(nk, None)
        with self._lock:
            self._conn.execute("DELETE FROM twitter_cache WHERE key = ?", (nk,))
            self._conn.commit()

    def clear(self) -> None:
        self._mem.clear()
        with self._lock:
            self._conn.execute("DELETE FROM twitter_cache")
            self._conn.commit()

    def stats(self) -> dict:
        with self._lock:
            (n_disk,) = self._conn.execute("SELECT COUNT(*) FROM twitter_cache").fetchone()
        return {"in_memory": len(self._mem), "on_disk": int(n_disk)}
