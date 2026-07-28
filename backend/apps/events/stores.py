"""On-disk state for the event engine under DATA_ROOT/events/:
  cursors/<trigger_id>.json   adapter-defined position (mtime map, page hash, ...)
  pending/<trigger_id>.json   events buffered but not yet fired (survives restart)
  logs/<workflow_id>.json     bounded activity log ("saw X, skipped because Y")
"""

import os
from typing import Dict, List

from typeguard import typechecked

from backend.apps.events.models import Event, EventLogEntry
from backend.config.json_store import atomic_write_json, read_json_or_none
from backend.config.paths import DATA_ROOT

EVENTS_DIR = os.path.join(DATA_ROOT, "events")
CURSORS_DIR = os.path.join(EVENTS_DIR, "cursors")
PENDING_DIR = os.path.join(EVENTS_DIR, "pending")
LOGS_DIR = os.path.join(EVENTS_DIR, "logs")

LOG_ENTRIES_MAX = 200


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
    for directory, keep in ((CURSORS_DIR, keep_triggers), (PENDING_DIR, keep_triggers), (LOGS_DIR, keep_workflows)):
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
