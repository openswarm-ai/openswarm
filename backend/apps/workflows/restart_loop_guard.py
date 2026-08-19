"""Scheduled-run restart-loop breaker (lifted from hermes-agent gateway/restart_loop_guard.py,
MIT; their incident #30719: a session that restarts its own gateway gets auto-resumed on boot,
which restarts the gateway again, SIGTERM every ~10s forever).

Our version of that loop: a scheduled workflow whose run kills the backend is overdue again the
moment the backend boots, so the scheduler re-fires it, which kills the backend again. This
breaker persists a rolling window of boots plus which workflow was MID-FIRE at each death; a
workflow implicated in consecutive dirty deaths during a boot storm gets its schedule paused
with a note instead of fired, which breaks the cycle and puts a human back in the loop.

Everything here fails OPEN (hermes's own rule: any read/write failure means no trip), because
a broken breaker must never wedge a healthy scheduler."""

import json
import logging
import os
import time
from typing import Dict, List, Optional

from typeguard import typechecked

from backend.apps.workflows.storage import DATA_DIR

logger = logging.getLogger(__name__)

# Hermes defaults: a legitimate operator restart or two never trips; a tight respawn loop does.
MAX_BOOTS = 3
WINDOW_SECONDS = 600
IMPLICATED_TRIP_COUNT = 2


def p_state_path() -> str:
    return os.path.join(DATA_DIR, "restart_loop.json")


@typechecked
def p_load() -> Dict:
    try:
        with open(p_state_path(), encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return {}
        return data
    except (OSError, ValueError):
        return {}


@typechecked
def p_save(state: Dict) -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(p_state_path(), "w", encoding="utf-8") as f:
            json.dump(state, f)
    except OSError:
        pass


@typechecked
def record_boot(now: Optional[float] = None) -> List[float]:
    """Called once at scheduler start: prune the boot window, append this boot, and convert any
    stale mid-fire marker into an implication (the last life died while that workflow ran)."""
    ts = time.time() if now is None else now
    state = p_load()
    boots = [float(t) for t in state.get("boots", []) if isinstance(t, (int, float)) and t >= ts - WINDOW_SECONDS]
    boots.append(ts)
    implicated = dict(state.get("implicated", {}))
    for wf_id in list(state.get("firing", {}) or {}):
        implicated[wf_id] = int(implicated.get(wf_id, 0)) + 1
        logger.warning(f"restart-loop guard: workflow {wf_id} was mid-fire when the last backend life died (implication #{implicated[wf_id]})")
    p_save({"boots": boots, "implicated": implicated, "firing": {}})
    return boots


@typechecked
def mark_firing(workflow_id: str) -> None:
    state = p_load()
    firing = dict(state.get("firing", {}))
    firing[workflow_id] = time.time()
    state["firing"] = firing
    p_save(state)


@typechecked
def clear_firing(workflow_id: str) -> None:
    """A run that ENDS (success or failure) proves the workflow doesn't kill the process; its
    implication history is forgiven so one old crash can never combine with a later one."""
    state = p_load()
    state.get("firing", {}).pop(workflow_id, None)
    if workflow_id in state.get("implicated", {}):
        state["implicated"].pop(workflow_id, None)
    p_save(state)


@typechecked
def is_tripped(workflow_id: str, now: Optional[float] = None) -> bool:
    """True when the process is boot-storming AND this workflow died mid-fire in consecutive
    lives. Both legs required: a crashy workflow on a stable backend surfaces through the normal
    failed-run path, and a boot storm with no implicated workflow is not the scheduler's fault."""
    try:
        ts = time.time() if now is None else now
        state = p_load()
        boots = [t for t in state.get("boots", []) if isinstance(t, (int, float)) and t >= ts - WINDOW_SECONDS]
        if len(boots) < MAX_BOOTS:
            return False
        return int(state.get("implicated", {}).get(workflow_id, 0)) >= IMPLICATED_TRIP_COUNT
    except Exception:
        return False


@typechecked
def clear() -> None:
    try:
        os.unlink(p_state_path())
    except OSError:
        pass
