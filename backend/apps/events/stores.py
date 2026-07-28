"""On-disk state for the event engine under DATA_ROOT/events/:
  cursors/<trigger_id>.json   adapter-defined position (mtime map, page hash, ...)
  pending/<trigger_id>.json   events buffered but not yet fired (survives restart)
  logs/<workflow_id>.json     bounded activity log ("saw X, skipped because Y")
"""

import os
import time
from typing import Dict, List

from typeguard import typechecked

from backend.apps.events.models import Event, EventLogEntry
from backend.config.json_store import atomic_write_json, read_json_or_none
from backend.config.paths import DATA_ROOT

EVENTS_DIR = os.path.join(DATA_ROOT, "events")
CURSORS_DIR = os.path.join(EVENTS_DIR, "cursors")
PENDING_DIR = os.path.join(EVENTS_DIR, "pending")
LOGS_DIR = os.path.join(EVENTS_DIR, "logs")
FIRES_DIR = os.path.join(EVENTS_DIR, "fires")
HEALTH_DIR = os.path.join(EVENTS_DIR, "health")

LOG_ENTRIES_MAX = 200
FIRES_MAX = 100


@typechecked
def load_cursor(trigger_id: str) -> Dict:
    return read_json_or_none(os.path.join(CURSORS_DIR, f"{trigger_id}.json")) or {}


@typechecked
def save_cursor(trigger_id: str, cursor: Dict) -> None:
    atomic_write_json(os.path.join(CURSORS_DIR, f"{trigger_id}.json"), cursor)


@typechecked
def load_pending(trigger_id: str) -> List[Event]:
    raw = read_json_or_none(os.path.join(PENDING_DIR, f"{trigger_id}.json"))
    if not isinstance(raw, list):
        return []
    out: List[Event] = []
    for item in raw:
        try:
            out.append(Event(**item))
        except Exception:
            continue
    return out


@typechecked
def save_pending(trigger_id: str, events: List[Event]) -> None:
    path = os.path.join(PENDING_DIR, f"{trigger_id}.json")
    if not events:
        if os.path.exists(path):
            os.remove(path)
        return
    atomic_write_json(path, [e.model_dump(mode="json") for e in events])


@typechecked
def record_fire(trigger_id: str, when_epoch: float) -> None:
    """Persisted so the rate cap survives restarts (and any process confusion)."""
    path = os.path.join(FIRES_DIR, f"{trigger_id}.json")
    raw = read_json_or_none(path)
    arr = [float(x) for x in raw] if isinstance(raw, list) else []
    arr.append(float(when_epoch))
    atomic_write_json(path, arr[-FIRES_MAX:])


@typechecked
def recent_fire_count(trigger_id: str, now_epoch: float, window_seconds: float = 3600.0) -> int:
    raw = read_json_or_none(os.path.join(FIRES_DIR, f"{trigger_id}.json"))
    if not isinstance(raw, list):
        return 0
    cutoff = now_epoch - window_seconds
    return sum(1 for x in raw if isinstance(x, (int, float)) and float(x) >= cutoff)


@typechecked
def record_poll_failure(trigger_id: str, error: str = "") -> int:
    """Returns the new consecutive-failure count."""
    path = os.path.join(HEALTH_DIR, f"{trigger_id}.json")
    raw = read_json_or_none(path) or {}
    count = int(raw.get("consecutive_failures") or 0) + 1
    atomic_write_json(path, {"consecutive_failures": count, "last_error": error[:300], "last_failure_epoch": time.time()})
    return count


@typechecked
def read_poll_health(trigger_id: str) -> Dict:
    return read_json_or_none(os.path.join(HEALTH_DIR, f"{trigger_id}.json")) or {}


@typechecked
def clear_poll_failures(trigger_id: str) -> None:
    path = os.path.join(HEALTH_DIR, f"{trigger_id}.json")
    if os.path.exists(path):
        os.remove(path)


@typechecked
def append_log(workflow_id: str, entry: EventLogEntry) -> None:
    path = os.path.join(LOGS_DIR, f"{workflow_id}.json")
    raw = read_json_or_none(path)
    arr = raw if isinstance(raw, list) else []
    arr.append(entry.model_dump(mode="json"))
    if len(arr) > LOG_ENTRIES_MAX:
        del arr[: len(arr) - LOG_ENTRIES_MAX]
    atomic_write_json(path, arr)


@typechecked
def read_log(workflow_id: str) -> List[EventLogEntry]:
    raw = read_json_or_none(os.path.join(LOGS_DIR, f"{workflow_id}.json"))
    if not isinstance(raw, list):
        return []
    out: List[EventLogEntry] = []
    for item in raw:
        try:
            out.append(EventLogEntry(**item))
        except Exception:
            continue
    return out


@typechecked
def sweep_stale_state(live_trigger_ids: List[str], live_workflow_ids: List[str]) -> None:
    """Drop cursor/pending/log files whose owner no longer exists (trigger edited
    away, workflow purged). Runs once at engine start; keeps the data dir from
    accumulating orphans forever."""
    keep_triggers = set(live_trigger_ids)
    keep_workflows = set(live_workflow_ids)
    for directory, keep in ((CURSORS_DIR, keep_triggers), (PENDING_DIR, keep_triggers), (FIRES_DIR, keep_triggers), (HEALTH_DIR, keep_triggers), (LOGS_DIR, keep_workflows)):
        if not os.path.isdir(directory):
            continue
        for fname in os.listdir(directory):
            if not fname.endswith(".json"):
                continue
            if fname[:-5] not in keep:
                try:
                    os.remove(os.path.join(directory, fname))
                except OSError:
                    pass
