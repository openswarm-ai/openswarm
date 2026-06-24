"""Per-session WS event sequencing, ring buffer, and terminal-event persistence for resilient reconnects."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections import deque
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

logger = logging.getLogger(__name__)

# 500 events covers a 30s drop even at ~20Hz thinking deltas (~50KB/session).
BUFFER_LIMIT = 500

TERMINAL_STATUSES = {"completed", "stopped", "error"}


class p_SessionSeqLog:
    """Per-session lock + monotonic seq + recent-event ring buffer."""

    __slots__ = ("lock", "seq", "buffer")

    def __init__(self) -> None:
        self.lock: asyncio.Lock = asyncio.Lock()
        self.seq: int = 0
        # (seq, json_payload_str): pre-serialized so replays don't redo json.dumps per reconnect.
        self.buffer: deque[tuple[int, str]] = deque(maxlen=BUFFER_LIMIT)


class SeqLogStore:
    """Process-wide store. Per-session locks live inside `p_SessionSeqLog`."""

    def __init__(self, persist_dir: Optional[str] = None) -> None:
        self.per_session: dict[str, p_SessionSeqLog] = {}
        # Coarse lock guards only the setdefault path; never crosses an await.
        self.p_dict_lock = asyncio.Lock()
        self.p_persist_dir = persist_dir
        if persist_dir:
            try:
                os.makedirs(persist_dir, exist_ok=True)
            except Exception:
                logger.warning("seq_log: failed to create persist dir %s", persist_dir)

    async def p_get_or_create(self, session_id: str) -> p_SessionSeqLog:
        log = self.per_session.get(session_id)
        if log is not None:
            return log
        async with self.p_dict_lock:
            log = self.per_session.get(session_id)
            if log is None:
                log = p_SessionSeqLog()
                self.per_session[session_id] = log
            return log

    def p_peek(self, session_id: str) -> Optional[p_SessionSeqLog]:
        return self.per_session.get(session_id)

    @asynccontextmanager
    async def stamp(
        self, session_id: str, event: str, data: dict
    ) -> AsyncIterator[tuple[int, str]]:
        """Atomically assign seq, buffer, and yield (seq, payload); caller's send must happen inside the with-block."""
        log = await self.p_get_or_create(session_id)
        async with log.lock:
            log.seq += 1
            seq = log.seq
            payload = {
                "event": event,
                "session_id": session_id,
                "data": data,
                "seq": seq,
            }
            payload_str = json.dumps(payload)
            log.buffer.append((seq, payload_str))
            yield seq, payload_str

    def replay(
        self, session_id: str, last_seq: int
    ) -> tuple[Optional[int], Optional[int], list[str]]:
        """Return (oldest_buffered_seq, newest_buffered_seq, events)."""
        log = self.p_peek(session_id)
        if log is None:
            return (None, None, [])
        # asyncio is single-threaded; deque list() is safe vs concurrent append/eviction. No lock needed for read.
        snapshot = list(log.buffer)
        if not snapshot:
            return (None, log.seq, [])
        oldest = snapshot[0][0]
        newest = snapshot[-1][0]
        events = [s for (i, s) in snapshot if i > last_seq]
        return (oldest, newest, events)

    def current_seq(self, session_id: str) -> int:
        """Last assigned seq, or 0 if no log exists for the session."""
        log = self.p_peek(session_id)
        return log.seq if log else 0

    def p_terminal_path(self, session_id: str) -> Optional[str]:
        if not self.p_persist_dir:
            return None
        # Session ids are uuid4 hex; sanitize anyway against path traversal.
        safe = "".join(c for c in session_id if c.isalnum() or c in ("-", "_"))
        if not safe:
            return None
        return os.path.join(self.p_persist_dir, f"{safe}.json")

    def persist_terminal(self, session_id: str, payload_str: str) -> None:
        """Atomic write of a terminal event for post-restart clients; best-effort, never blocks broadcast."""
        path = self.p_terminal_path(session_id)
        if not path:
            return
        try:
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(payload_str)
            os.replace(tmp, path)
        except Exception:
            logger.debug(
                "seq_log: failed to persist terminal event for %s", session_id, exc_info=True
            )

    def load_terminal(self, session_id: str) -> Optional[str]:
        path = self.p_terminal_path(session_id)
        if not path or not os.path.exists(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception:
            return None

    def clear(self, session_id: str) -> None:
        """Drop in-memory log and persisted terminal; for full deletion only, closed-but-retained sessions keep it."""
        self.per_session.pop(session_id, None)
        path = self.p_terminal_path(session_id)
        if path and os.path.exists(path):
            try:
                os.remove(path)
            except Exception:
                pass


def p_default_persist_dir() -> Optional[str]:
    try:
        from backend.config.paths import DATA_ROOT
        return os.path.join(DATA_ROOT, "agents", "terminal_events")
    except Exception:
        return None


seq_log = SeqLogStore(persist_dir=p_default_persist_dir())
