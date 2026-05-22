"""Append-only audit log for workflow edits.

One JSONL file per workflow at <DATA_ROOT>/workflows/audit/<wid>.jsonl. We
diff before/after rather than snapshotting the full record so the file
stays small even after dozens of edits. Read path tails the file; we don't
keep this in memory because audits are inspected rarely.
"""

import json
import logging
import os
from datetime import datetime, timezone
from threading import Lock
from typing import Any

from backend.apps.workflows.storage import DATA_DIR

logger = logging.getLogger(__name__)

AUDIT_DIR = os.path.join(DATA_DIR, "audit")
_io_lock = Lock()
# Soft cap on bytes per audit file. When exceeded we truncate to the last
# CAP/2 bytes on next write so attackers (or a runaway PATCH loop) can't
# fill the disk. 256 KiB is ~2000 edits; we never expect to hit it.
SOFT_CAP_BYTES = 256 * 1024


def _audit_path(wid: str) -> str:
    return os.path.join(AUDIT_DIR, f"{wid}.jsonl")


def _diff(before: dict, after: dict) -> dict[str, dict[str, Any]]:
    """Return only the keys whose value changed. Nested dicts are diffed
    shallowly; the schedule/actions/permissions blocks are small so we just
    record the whole sub-dict when any sub-key changes.
    """
    changed: dict[str, dict[str, Any]] = {}
    keys = set(before) | set(after)
    for k in keys:
        b = before.get(k)
        a = after.get(k)
        if b != a:
            changed[k] = {"before": b, "after": a}
    return changed


def log_change(wid: str, who: str, before: dict, after: dict) -> None:
    diff = _diff(before, after)
    if not diff:
        return
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "who": who,
        "diff": diff,
    }
    try:
        with _io_lock:
            os.makedirs(AUDIT_DIR, exist_ok=True)
            path = _audit_path(wid)
            if os.path.exists(path) and os.path.getsize(path) > SOFT_CAP_BYTES:
                # Keep the tail half. Cheap, lossy, prevents pathological
                # disk growth without crashing on a corrupt file.
                with open(path, "rb") as f:
                    f.seek(-(SOFT_CAP_BYTES // 2), os.SEEK_END)
                    tail = f.read()
                first_nl = tail.find(b"\n")
                tail = tail[first_nl + 1:] if first_nl >= 0 else b""
                with open(path, "wb") as f:
                    f.write(tail)
            with open(path, "a") as f:
                f.write(json.dumps(entry) + "\n")
    except Exception:
        logger.debug("audit log_change failed", exc_info=True)


def read_tail(wid: str, limit: int = 50) -> list[dict]:
    path = _audit_path(wid)
    if not os.path.exists(path):
        return []
    try:
        with open(path) as f:
            lines = f.readlines()
    except Exception:
        return []
    out: list[dict] = []
    for line in lines[-limit:]:
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            continue
    out.reverse()
    return out
