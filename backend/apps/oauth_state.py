"""Pending and recently-completed OAuth flows.

The pending map used to live only in memory, and the gap that opens is the whole of ENG-363: the
user clicks Connect, the browser leaves for the provider, the backend restarts for ANY reason
(uvicorn reload in dev, the ENG-357 frozen-loop exit, a watchdog respawn, a crash), and the state
that proves the returning callback is ours is simply gone. The callback then lands on the
unknown-state branch and renders "Session expired", the Settings row spins forever, and the user
concludes the product cannot connect to Anthropic. Haik reported exactly that.

Retrying is not the fix, because the user is not the one who failed. Making the state outlive a
restart is: the callback then completes on its own and there is nothing to click.

The verifier is a short-lived, single-use secret, so it is written 0600, expires on a TTL, and is
deleted the moment it is consumed. It never becomes a durable credential lying around on disk.
"""

import json
import os
import time
from typing import Dict, Optional

from typeguard import typechecked

from backend.config.paths import DATA_ROOT

# One OAuth round trip is a browser hop and a login; a quarter hour is generous for a human doing that, and short enough that an abandoned flow's verifier does not linger.
PENDING_TTL_S = 15 * 60

PENDING_PATH = os.path.join(DATA_ROOT, "pending_oauth.json")


@typechecked
def p_load() -> Dict[str, dict]:
    """Read the durable map, dropping anything past its TTL. Unreadable state is treated as empty: a corrupt file must not make Connect permanently impossible."""
    try:
        with open(PENDING_PATH, encoding="utf-8") as fh:
            raw = json.load(fh)
    except Exception:
        return {}
    if not isinstance(raw, dict):
        return {}
    now = time.time()
    return {
        k: v for k, v in raw.items()
        if isinstance(v, dict) and float(v.get("stored_at", 0) or 0) + PENDING_TTL_S > now
    }


@typechecked
def p_store(entries: Dict[str, dict]) -> None:
    """Write 0600 and replace atomically, so a crash mid-write cannot leave a half-parsed file that strands every later Connect."""
    try:
        os.makedirs(DATA_ROOT, exist_ok=True)
        tmp = f"{PENDING_PATH}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(entries, fh)
        os.chmod(tmp, 0o600)
        os.replace(tmp, PENDING_PATH)
    except OSError:
        pass


class PendingOAuth:
    """Dict-shaped so every existing call site keeps working, but backed by disk.

    Deliberately not a plain dict subclass: the whole point is that reads come from the file, so an
    entry written before a restart is still found by the process that comes back.
    """

    @typechecked
    def __setitem__(self, state: str, value: dict) -> None:
        entries = p_load()
        entries[state] = {**value, "stored_at": time.time()}
        p_store(entries)

    @typechecked
    def get(self, state: str, default: Optional[dict] = None) -> Optional[dict]:
        return p_load().get(state, default)

    @typechecked
    def pop(self, state: str, default: Optional[dict] = None) -> Optional[dict]:
        entries = p_load()
        found = entries.pop(state, None)
        if found is None:
            return default
        # Consumed: the verifier is single-use, so it stops existing here rather than aging out later.
        p_store(entries)
        return found

    @typechecked
    def __contains__(self, state: str) -> bool:
        return state in p_load()

    @typechecked
    def __len__(self) -> int:
        return len(p_load())


pending_oauth = PendingOAuth()
# Recently-completed OAuth states so the /api/subscriptions/callback handler can distinguish a legitimate duplicate callback (browser prefetch, refresh, or Google redirect retry after a slow first response) from a truly stale request. Bounded FIFO, drops the oldest entries once it grows past MAX_COMPLETED_OAUTH so it can't leak memory.
completed_oauth: list[str] = []
MAX_COMPLETED_OAUTH = 64


@typechecked
def mark_oauth_completed(state: str) -> None:
    if state in completed_oauth:
        return
    completed_oauth.append(state)
    # Trim head if we've outgrown the bound
    while len(completed_oauth) > MAX_COMPLETED_OAUTH:
        completed_oauth.pop(0)
