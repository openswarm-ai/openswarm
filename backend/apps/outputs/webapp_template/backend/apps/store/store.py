"""Disk-backed app state. Use this instead of module-level variables for anything worth keeping.

The app's process is DISPOSABLE: OpenSwarm freezes it when its card closes, kills it after ~15
minutes idle, on quit, and on crash. A module-level list or dict therefore silently loses the
user's data on a schedule you don't control. This store survives all of that: one JSON file under
backend/data/, written atomically so a kill mid-write can never corrupt it.

    from backend.apps.store.store import load_store, save_store

    items = load_store().get("items", [])
    items.append(new_item)
    save_store({**load_store(), "items": items})
"""

import json
import os
import tempfile
from typing import Any, Dict

from typeguard import typechecked

P_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(P_BACKEND_DIR, "data")
STORE_PATH = os.path.join(DATA_DIR, "store.json")


@typechecked
def load_store() -> Dict[str, Any]:
    """The whole store as a dict; empty on first run or an unreadable file, never an exception."""
    try:
        with open(STORE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


@typechecked
def save_store(data: Dict[str, Any]) -> None:
    """Replace the store atomically: temp file then rename, so a kill mid-write leaves the old data."""
    os.makedirs(DATA_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, STORE_PATH)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
