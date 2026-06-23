"""On-disk store for workflows + workflow runs.

Layout under DATA_ROOT/workflows/:
  <id>.json              workflow record
  runs/<workflow_id>.json  bounded log (latest N) of runs for that workflow

A separate runs file per workflow keeps history reads O(history size) instead
of O(total runs across all workflows). The workflow record only carries
last_run_* / next_run_at summary fields; full history lives in the runs file.
"""

import json
import os
import tempfile
from threading import Lock
from typing import Optional

from backend.config.paths import DATA_ROOT
from backend.apps.workflows.models import Workflow, WorkflowRun, MissedRun

DATA_DIR = os.path.join(DATA_ROOT, "workflows")
RUNS_DIR = os.path.join(DATA_DIR, "runs")
PAUSED_FILE = os.path.join(DATA_DIR, "paused.json")
MISSED_FILE = os.path.join(DATA_DIR, "missed.json")

# Hard ceiling on pending missed fires kept on disk. The review card only
# shows 50; this just stops the file growing without bound if the user keeps
# quitting without acting on the card.
MAX_MISSED = 200

_io_lock = Lock()
_workflow_cache: dict[str, Workflow] = {}
_runs_cache: dict[str, list[WorkflowRun]] = {}
_missed_cache: list[MissedRun] = []
_cache_loaded = False
_paused = False


def _resolve_host_tz_name() -> str:
    """Best-effort IANA name for the host. Mirrors apps/service/client.py."""
    name = os.environ.get("OPENSWARM_TIMEZONE", "").strip()
    if not name:
        try:
            from tzlocal import get_localzone_name  # type: ignore
            name = get_localzone_name() or ""
        except Exception:
            name = ""
    return name or "UTC"

# Keep this much run history per workflow on disk. Older runs are pruned;
# the History tab caps at ~20 anyway, and unbounded growth turned the JSON
# read into a real cost on hot-reload of the schedule page.
RUNS_PER_WORKFLOW = 200


def _ensure_dirs() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(RUNS_DIR, exist_ok=True)


def _wf_path(wid: str) -> str:
    return os.path.join(DATA_DIR, f"{wid}.json")


def _runs_path(wid: str) -> str:
    return os.path.join(RUNS_DIR, f"{wid}.json")


def p_atomic_write_json(path: str, data: object) -> None:
    """Write JSON crash-safely: a power-off mid-write must not leave a truncated
    file, because the loader drops a workflow whose JSON fails to parse (the
    record would silently vanish). Write a unique sibling temp file, fsync it,
    then os.replace (atomic on POSIX and Windows) so readers only ever see the
    old complete file or the new complete one."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _load_all_from_disk() -> None:
    global _cache_loaded, _paused
    _ensure_dirs()
    _workflow_cache.clear()
    _runs_cache.clear()
    host_tz = _resolve_host_tz_name()
    for fname in os.listdir(DATA_DIR):
        if not fname.endswith(".json") or fname == "paused.json":
            continue
        try:
            with open(os.path.join(DATA_DIR, fname)) as f:
                wf = Workflow(**json.load(f))
            # Coerce legacy timezone="local" to the host IANA zone in
            # memory only. We don't rewrite the file here so backup/sync
            # tooling doesn't see mtime churn on every startup; the next
            # user-driven save migrates the on-disk record naturally.
            if wf.schedule.timezone == "local":
                wf.schedule.timezone = host_tz
            _workflow_cache[wf.id] = wf
        except Exception:
            continue
    if os.path.exists(RUNS_DIR):
        for fname in os.listdir(RUNS_DIR):
            if not fname.endswith(".json"):
                continue
            wid = fname[:-5]
            try:
                with open(os.path.join(RUNS_DIR, fname)) as f:
                    arr = json.load(f)
                _runs_cache[wid] = [WorkflowRun(**r) for r in arr]
            except Exception:
                _runs_cache[wid] = []
    # Load the global pause flag if it's been set previously.
    if os.path.exists(PAUSED_FILE):
        try:
            with open(PAUSED_FILE) as f:
                _paused = bool(json.load(f).get("paused", False))
        except Exception:
            _paused = False
    _missed_cache.clear()
    if os.path.exists(MISSED_FILE):
        try:
            with open(MISSED_FILE) as f:
                _missed_cache.extend(MissedRun(**m) for m in json.load(f))
        except Exception:
            _missed_cache.clear()
    _cache_loaded = True


def init() -> None:
    with _io_lock:
        _load_all_from_disk()


def list_workflows() -> list[Workflow]:
    if not _cache_loaded:
        init()
    # Soft-deleted records are filtered here so the scheduler, calendar, and
    # every list view skip them with no per-caller guard. Trash reads via
    # list_deleted_workflows; restore/purge fetch by id with get_workflow.
    return [w for w in _workflow_cache.values() if w.deleted_at is None]


def list_deleted_workflows() -> list[Workflow]:
    if not _cache_loaded:
        init()
    return [w for w in _workflow_cache.values() if w.deleted_at is not None]


def get_workflow(wid: str) -> Optional[Workflow]:
    if not _cache_loaded:
        init()
    return _workflow_cache.get(wid)


def save_workflow(wf: Workflow) -> Workflow:
    with _io_lock:
        _ensure_dirs()
        _workflow_cache[wf.id] = wf
        p_atomic_write_json(_wf_path(wf.id), wf.model_dump(mode="json"))
    return wf


def delete_workflow(wid: str) -> bool:
    with _io_lock:
        existed = wid in _workflow_cache
        _workflow_cache.pop(wid, None)
        _runs_cache.pop(wid, None)
        wf_file = _wf_path(wid)
        if os.path.exists(wf_file):
            os.remove(wf_file)
        rf = _runs_path(wid)
        if os.path.exists(rf):
            os.remove(rf)
        if any(m.workflow_id == wid for m in _missed_cache):
            _missed_cache[:] = [m for m in _missed_cache if m.workflow_id != wid]
            _write_missed()
    return existed


def list_runs(wid: str, limit: int = 50) -> list[WorkflowRun]:
    if not _cache_loaded:
        init()
    runs = _runs_cache.get(wid, [])
    return runs[-limit:][::-1]


def list_all_runs(limit: int = 200) -> list[WorkflowRun]:
    if not _cache_loaded:
        init()
    flat: list[WorkflowRun] = []
    for arr in _runs_cache.values():
        flat.extend(arr)
    flat.sort(key=lambda r: r.started_at, reverse=True)
    return flat[:limit]


def record_run(run: WorkflowRun) -> WorkflowRun:
    with _io_lock:
        _ensure_dirs()
        arr = _runs_cache.setdefault(run.workflow_id, [])
        # Replace prior entry with same id if we're updating an in-flight run.
        for i, prior in enumerate(arr):
            if prior.id == run.id:
                arr[i] = run
                break
        else:
            arr.append(run)
        # Bound the per-workflow history to keep disk + memory cheap.
        if len(arr) > RUNS_PER_WORKFLOW:
            del arr[: len(arr) - RUNS_PER_WORKFLOW]
        p_atomic_write_json(_runs_path(run.workflow_id), [r.model_dump(mode="json") for r in arr])
    return run


def get_paused() -> bool:
    if not _cache_loaded:
        init()
    return _paused


def set_paused(value: bool) -> bool:
    global _paused
    with _io_lock:
        _ensure_dirs()
        _paused = bool(value)
        p_atomic_write_json(PAUSED_FILE, {"paused": _paused})
    return _paused


def _write_missed() -> None:
    p_atomic_write_json(MISSED_FILE, [m.model_dump(mode="json") for m in _missed_cache])


def list_missed() -> list[MissedRun]:
    if not _cache_loaded:
        init()
    return list(_missed_cache)


def add_missed(run: MissedRun) -> MissedRun:
    if not _cache_loaded:
        init()
    with _io_lock:
        _ensure_dirs()
        _missed_cache.append(run)
        # Keep the newest MAX_MISSED by scheduled_for so a never-acked card
        # can't grow the file forever across repeated launches.
        if len(_missed_cache) > MAX_MISSED:
            _missed_cache.sort(key=lambda m: m.scheduled_for)
            del _missed_cache[: len(_missed_cache) - MAX_MISSED]
        _write_missed()
    return run


def remove_missed(ids: list[str]) -> None:
    if not _cache_loaded:
        init()
    drop = set(ids)
    with _io_lock:
        _ensure_dirs()
        _missed_cache[:] = [m for m in _missed_cache if m.id not in drop]
        _write_missed()


def clear_missed() -> None:
    if not _cache_loaded:
        init()
    with _io_lock:
        _ensure_dirs()
        _missed_cache.clear()
        _write_missed()


def update_run(run_id: str, **fields) -> Optional[WorkflowRun]:
    if not _cache_loaded:
        init()
    for arr in _runs_cache.values():
        for i, r in enumerate(arr):
            if r.id == run_id:
                updated = r.model_copy(update=fields)
                arr[i] = updated
                with _io_lock:
                    p_atomic_write_json(_runs_path(updated.workflow_id), [x.model_dump(mode="json") for x in arr])
                return updated
    return None
