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
from threading import Lock
from typing import Optional

from backend.config.paths import DATA_ROOT
from backend.apps.workflows.models import Workflow, WorkflowRun

DATA_DIR = os.path.join(DATA_ROOT, "workflows")
RUNS_DIR = os.path.join(DATA_DIR, "runs")

_io_lock = Lock()
_workflow_cache: dict[str, Workflow] = {}
_runs_cache: dict[str, list[WorkflowRun]] = {}
_cache_loaded = False

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


def _load_all_from_disk() -> None:
    global _cache_loaded
    _ensure_dirs()
    _workflow_cache.clear()
    _runs_cache.clear()
    for fname in os.listdir(DATA_DIR):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(DATA_DIR, fname)) as f:
                wf = Workflow(**json.load(f))
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
    _cache_loaded = True


def init() -> None:
    with _io_lock:
        _load_all_from_disk()


def list_workflows() -> list[Workflow]:
    if not _cache_loaded:
        init()
    return list(_workflow_cache.values())


def get_workflow(wid: str) -> Optional[Workflow]:
    if not _cache_loaded:
        init()
    return _workflow_cache.get(wid)


def save_workflow(wf: Workflow) -> Workflow:
    with _io_lock:
        _ensure_dirs()
        _workflow_cache[wf.id] = wf
        with open(_wf_path(wf.id), "w") as f:
            json.dump(wf.model_dump(mode="json"), f, indent=2)
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
    return existed


def list_runs(wid: str, limit: int = 50) -> list[WorkflowRun]:
    if not _cache_loaded:
        init()
    runs = _runs_cache.get(wid, [])
    return runs[-limit:][::-1]


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
        with open(_runs_path(run.workflow_id), "w") as f:
            json.dump([r.model_dump(mode="json") for r in arr], f, indent=2)
    return run


def update_run(run_id: str, **fields) -> Optional[WorkflowRun]:
    if not _cache_loaded:
        init()
    for arr in _runs_cache.values():
        for i, r in enumerate(arr):
            if r.id == run_id:
                updated = r.model_copy(update=fields)
                arr[i] = updated
                with _io_lock:
                    with open(_runs_path(updated.workflow_id), "w") as f:
                        json.dump([x.model_dump(mode="json") for x in arr], f, indent=2)
                return updated
    return None
