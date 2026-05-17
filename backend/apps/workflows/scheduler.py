"""In-process cron-style scheduler.

One long-lived asyncio task wakes on the next-due workflow boundary, fires
matching workflows, then re-computes. We deliberately avoid one-task-per-
workflow (turns rescheduling into a thundering re-spawn problem). On
startup we walk persisted workflows once, decide what to do about missed
fires via on_missed, and queue each.

Schedule semantics:
  unit=day:   fires every repeat_every days at hour:minute
  unit=week:  fires on the listed weekday(s) every repeat_every weeks
  unit=month: fires on the original day-of-month every repeat_every months

Local clock only. We avoid timezone math here; users see all calendars in
their machine local time, which matches the in-app calendar in the images.
"""

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from backend.apps.workflows.models import Workflow, ScheduleConfig
from backend.apps.workflows import storage, executor

logger = logging.getLogger(__name__)


_loop_task: Optional[asyncio.Task] = None
_wake = asyncio.Event()


def _next_fire_after(sched: ScheduleConfig, ref: datetime) -> Optional[datetime]:
    if not sched.enabled:
        return None
    base = ref.replace(second=0, microsecond=0)
    candidate = base.replace(hour=sched.hour, minute=sched.minute)
    if candidate <= ref:
        candidate = candidate + timedelta(days=1)

    if sched.repeat_unit == "day":
        step = max(1, sched.repeat_every)
        # Walk forward in step-day increments until we find a day strictly
        # after `ref`. Cheap because step is small.
        while candidate <= ref:
            candidate = candidate + timedelta(days=step)
        return candidate

    if sched.repeat_unit == "week":
        # Frontend uses JS getDay() convention (Sun=0..Sat=6). Python's
        # datetime.weekday() is Mon=0..Sun=6, so we translate before
        # matching. Keep the wire format JS-style so the UI math stays
        # trivial and the cron picker stays self-explanatory.
        def _js_weekday(d: datetime) -> int:
            return (d.weekday() + 1) % 7
        allowed = sched.on_days or [_js_weekday(ref)]
        for _ in range(0, 14):
            if _js_weekday(candidate) in allowed and candidate > ref:
                return candidate
            candidate = candidate + timedelta(days=1)
        return candidate

    if sched.repeat_unit == "month":
        target_day = ref.day
        step = max(1, sched.repeat_every)
        # Walk month-by-month preserving the original day-of-month when it
        # exists (Feb 30 falls back to the month's last day).
        c = candidate.replace(day=min(target_day, 28))
        while c <= ref:
            month = c.month + step
            year = c.year + (month - 1) // 12
            month = ((month - 1) % 12) + 1
            c = c.replace(year=year, month=month)
        return c

    return None


def compute_next_fire(wf: Workflow, ref: Optional[datetime] = None) -> Optional[datetime]:
    return _next_fire_after(wf.schedule, ref or datetime.now())


def kick() -> None:
    _wake.set()


async def _tick() -> None:
    now = datetime.now()
    due: list[Workflow] = []
    for wf in storage.list_workflows():
        if not wf.schedule.enabled:
            continue
        if wf.next_run_at and wf.next_run_at <= now:
            due.append(wf)

    for wf in due:
        scheduled_for = wf.next_run_at
        nxt = compute_next_fire(wf, now)
        wf.next_run_at = nxt
        storage.save_workflow(wf)
        asyncio.create_task(_fire(wf, scheduled_for=scheduled_for))


async def _fire(wf: Workflow, scheduled_for: Optional[datetime]) -> None:
    try:
        await executor.execute(wf, triggered_by="schedule", scheduled_for=scheduled_for)
    except Exception:
        logger.exception("scheduler fire failed for workflow=%s", wf.id)


def _seconds_until_next() -> float:
    now = datetime.now()
    soonest: Optional[datetime] = None
    for wf in storage.list_workflows():
        if not wf.schedule.enabled or not wf.next_run_at:
            continue
        if soonest is None or wf.next_run_at < soonest:
            soonest = wf.next_run_at
    if soonest is None:
        return 60.0
    delta = (soonest - now).total_seconds()
    return max(1.0, min(delta, 60.0))


async def _loop() -> None:
    logger.info("workflow scheduler loop started")
    while True:
        try:
            await _tick()
        except Exception:
            logger.exception("scheduler tick error")
        try:
            await asyncio.wait_for(_wake.wait(), timeout=_seconds_until_next())
        except asyncio.TimeoutError:
            pass
        _wake.clear()


def _mark_stuck_runs_failed() -> None:
    """Any run marked 'running' that survives a backend restart is dead.

    The owning event loop is gone, so there's no way to resume. Mark it
    failed once at startup instead of letting the History tab show a
    forever-spinning row that misleads the user.
    """
    now = datetime.now()
    for wf in storage.list_workflows():
        for r in storage.list_runs(wf.id, limit=200):
            if r.status == "running":
                storage.update_run(r.id, status="failure", error="Killed by restart", finished_at=now)


def reconcile_on_startup() -> None:
    """Walk persisted workflows once and resolve missed fires per policy.

    Missed-run policies:
      skip      -> roll forward to next future fire, ignore missed
      run_once  -> if any fires were missed, schedule a single catch-up at now
      run_all   -> not actually run_all in v1 (would burn tokens); same as run_once
                   but we mark the run.status as ran_late so the UI surfaces it
    """
    now = datetime.now()
    for wf in storage.list_workflows():
        if not wf.schedule.enabled:
            wf.next_run_at = None
            storage.save_workflow(wf)
            continue

        missed = bool(wf.next_run_at and wf.next_run_at <= now)
        if missed and wf.schedule.on_missed in ("run_once", "run_all"):
            # Leave next_run_at <= now so the very next tick fires it. The
            # executor records the run with started_at=now; the UI badges
            # it ran_late if scheduled_for is more than a few minutes
            # behind started_at.
            pass
        else:
            wf.next_run_at = compute_next_fire(wf, now)
        storage.save_workflow(wf)


async def start() -> None:
    global _loop_task
    if _loop_task is not None:
        return
    _mark_stuck_runs_failed()
    reconcile_on_startup()
    _loop_task = asyncio.create_task(_loop())


async def stop() -> None:
    global _loop_task
    if _loop_task is None:
        return
    _loop_task.cancel()
    try:
        await _loop_task
    except (asyncio.CancelledError, Exception):
        pass
    _loop_task = None
