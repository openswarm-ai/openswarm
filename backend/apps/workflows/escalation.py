"""Server-side escalation timer.

The permission chain in the UI (notify -> text -> call) used to time out
client-side, which dies the moment the window closes. We move the timer
here so a run that finishes at 9am can escalate to a real text at 9:05am
whether or not the user has the app open. The text/call wire-up itself
still routes through notifier (cloud SMS bridge is wired separately); we
just own the *when*.

State lives in module-scoped dicts, not on disk. If the backend restarts
mid-escalation the chain is lost on purpose: the user is already in front
of an open app at that point (otherwise the backend wouldn't have started)
and they can ack manually. Persisting escalation state would mean
re-firing on a stale schedule after a multi-day downtime, which is worse.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from backend.apps.workflows.models import PermissionTier, Workflow, WorkflowRun

logger = logging.getLogger(__name__)


_tasks: dict[str, asyncio.Task] = {}  # run_id -> escalation task
_state: dict[str, dict] = {}  # run_id -> {tier_idx, next_at, kind}


def _tier_delay_seconds(tier: PermissionTier) -> int:
    """Tier minutes/hours convention matches the FE: text uses minutes,
    call uses hours (the UI label flips with tier.kind). We translate at
    the boundary so the backend math is always in seconds."""
    if tier.kind == "call":
        return max(0, tier.after_minutes) * 3600
    return max(0, tier.after_minutes) * 60


def schedule(wf: Workflow, run: WorkflowRun) -> None:
    """Kick off escalation for a finished run. No-op if the workflow has
    only the default notify tier (i.e. nothing to escalate to)."""
    tiers = wf.permissions or []
    if len(tiers) <= 1:
        return
    # Cancel any prior task for this run (defense against a re-fire).
    cancel(run.id)
    task = asyncio.create_task(_runner(wf, run, tiers))
    _tasks[run.id] = task


def cancel(run_id: str) -> bool:
    task = _tasks.pop(run_id, None)
    _state.pop(run_id, None)
    if task is None:
        return False
    task.cancel()
    return True


def status(run_id: str) -> Optional[dict]:
    return _state.get(run_id)


async def _runner(wf: Workflow, run: WorkflowRun, tiers: list[PermissionTier]) -> None:
    from backend.apps.workflows.notifier import send_tier

    try:
        # Tier 0 is the initial notify; we don't re-fire it here. Walk
        # 1..N, sleeping the tier's delay before sending. If the user acks
        # via /workflows/runs/{run_id}/ack, the task is cancelled.
        for idx in range(1, len(tiers)):
            tier = tiers[idx]
            delay = _tier_delay_seconds(tier)
            fire_at = datetime.now(timezone.utc) + timedelta(seconds=delay)
            _state[run.id] = {
                "tier_idx": idx,
                "tier_kind": tier.kind,
                "next_at": fire_at.isoformat(),
            }
            await asyncio.sleep(delay)
            try:
                await send_tier(wf, run, tier)
            except Exception:
                logger.exception("escalation send_tier failed run=%s tier=%s", run.id, tier.kind)
    except asyncio.CancelledError:
        pass
    finally:
        _state.pop(run.id, None)
        _tasks.pop(run.id, None)
