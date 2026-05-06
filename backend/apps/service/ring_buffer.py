"""Fixed-size event log for operational diagnostics.

Maintains a rolling window of the last N app events so support
diagnostics can include context about recent activity. Used by
the error report builder to attach "what just happened" when
something goes wrong.
"""

from __future__ import annotations

import threading
import time
from collections import deque

_MAX_SIZE = 50
_lock = threading.Lock()
_buffer: deque[dict] = deque(maxlen=_MAX_SIZE)


def record(label: str, **meta: str | int | float | None) -> None:
    """Append an entry. Oldest drops when full."""
    with _lock:
        _buffer.append({
            "l": label,
            "t": time.time(),
            **{k: v for k, v in meta.items() if v is not None},
        })


def snapshot() -> list[dict]:
    """Return a copy of the current buffer, oldest first."""
    with _lock:
        return list(_buffer)


def clear() -> None:
    with _lock:
        _buffer.clear()
