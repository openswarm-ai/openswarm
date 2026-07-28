"""Filesystem poll adapter. Watches one file or one directory (direct entries
only) by diffing an mtime/size snapshot kept in the cursor. First poll
baselines silently: what already exists isn't "new", so a fresh trigger never
fires on pre-existing files."""

import asyncio
import os
from typing import Dict, List, Tuple

from typeguard import typechecked

from backend.apps.events.models import Event, FileWatchSource

SKIP_NAMES = {".DS_Store", "Thumbs.db"}
MAX_TRACKED_ENTRIES = 2000
MAX_EVENTS_PER_POLL = 20


@typechecked
def p_snapshot(path: str) -> Dict[str, List[float]]:
    if os.path.isfile(path):
        st = os.stat(path)
        return {os.path.basename(path): [st.st_mtime, float(st.st_size)]}
    snap: Dict[str, List[float]] = {}
    if os.path.isdir(path):
        for name in sorted(os.listdir(path))[:MAX_TRACKED_ENTRIES]:
            if name.startswith(".") or name in SKIP_NAMES:
                continue
            try:
                st = os.stat(os.path.join(path, name))
            except OSError:
                continue
            snap[name] = [st.st_mtime, float(st.st_size)]
    return snap


@typechecked
def p_diff(path: str, before: Dict[str, List[float]], after: Dict[str, List[float]]) -> List[Event]:
    events: List[Event] = []
    for name, meta in after.items():
        if name not in before:
            events.append(Event(
                source="file", event_type="file_created",
                summary=f"New file: {os.path.join(path, name)}",
                dedup_key=f"{path}:{name}:created:{meta[0]}",
                payload={"path": os.path.join(path, name)},
            ))
        elif meta != before[name]:
            events.append(Event(
                source="file", event_type="file_modified",
                summary=f"File changed: {os.path.join(path, name)}",
                dedup_key=f"{path}:{name}:modified:{meta[0]}",
                payload={"path": os.path.join(path, name)},
            ))
    for name in before:
        if name not in after:
            events.append(Event(
                source="file", event_type="file_deleted",
                summary=f"File removed: {os.path.join(path, name)}",
                dedup_key=f"{path}:{name}:deleted",
                payload={"path": os.path.join(path, name)},
            ))
    if len(events) > MAX_EVENTS_PER_POLL:
        elided = len(events) - MAX_EVENTS_PER_POLL
        events = events[:MAX_EVENTS_PER_POLL]
        events.append(Event(
            source="file", event_type="changes_elided",
            summary=f"...and {elided} more filesystem changes in {path}",
            dedup_key=f"{path}:elided",
            payload={"path": path, "elided": elided},
        ))
    return events


@typechecked
async def file_watch(source: FileWatchSource, cursor: Dict) -> Tuple[List[Event], Dict]:
    path = os.path.expanduser(source.path.strip())
    if not path:
        return [], cursor
    # The stat storm on a big directory is blocking I/O; keep it off the event loop.
    after = await asyncio.to_thread(p_snapshot, path)
    baselined = bool(cursor.get("baselined")) and cursor.get("path") == path
    before_raw = cursor.get("files") if baselined else None
    new_cursor: Dict = {"baselined": True, "path": path, "files": after}
    if not isinstance(before_raw, dict):
        return [], new_cursor
    before: Dict[str, List[float]] = {
        str(k): [float(v[0]), float(v[1])]
        for k, v in before_raw.items()
        if isinstance(v, list) and len(v) == 2
    }
    return p_diff(path, before, after), new_cursor
