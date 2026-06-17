"""In-process cron-style scheduler.

One long-lived asyncio task wakes on the next-due workflow boundary, fires
matching workflows, then re-computes. We deliberately avoid one-task-per-
workflow (turns rescheduling into a thundering re-spawn problem). On
startup we walk persisted workflows once, decide what to do about missed
fires via on_missed, and queue each.

Schedule semantics:
  unit=minute: fires every repeat_every minutes (15 is the enforced floor)
  unit=hour:   fires every repeat_every hours at :minute past the hour
  unit=day:    fires every repeat_every days at hour:minute
  unit=week:   fires on the listed weekday(s) every repeat_every weeks
  unit=month:  fires on the original day-of-month every repeat_every months

Wall-clock math runs in the workflow's IANA timezone, then we convert to
UTC at the boundary. This is the only safe way to honor DST (a "9am
Monday" schedule must remain 9am local across spring-forward / fall-back).
Legacy records with timezone="local" are coerced to the host zone in
memory by storage._load_all_from_disk; the on-disk file is not rewritten
until the user's next save.
"""

import asyncio
import calendar
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from backend.apps.workflows.models import Workflow, ScheduleConfig
from backend.apps.workflows import storage, executor

logger = logging.getLogger(__name__)


_loop_task: Optional[asyncio.Task] = None
_wake = asyncio.Event()
_host_tz_cache: Optional[ZoneInfo] = None


def _host_tz() -> ZoneInfo:
    global _host_tz_cache
    if _host_tz_cache is not None:
        return _host_tz_cache
    name = os.environ.get("OPENSWARM_TIMEZONE", "").strip()
    if not name:
        try:
            from tzlocal import get_localzone_name  # type: ignore
            name = get_localzone_name() or ""
        except Exception:
            name = ""
    try:
        _host_tz_cache = ZoneInfo(name) if name else ZoneInfo("UTC")
    except ZoneInfoNotFoundError:
        _host_tz_cache = ZoneInfo("UTC")
    return _host_tz_cache


def _resolve_tz(tz: str) -> ZoneInfo:
    if not tz or tz == "local":
        return _host_tz()
    try:
        return ZoneInfo(tz)
    except ZoneInfoNotFoundError:
        return _host_tz()


def _as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Normalize an arbitrary stored datetime to aware-UTC.

    Pydantic deserializes naive ISO strings as naive datetimes. Treat such
    values as host-local (matches the pre-tz codepath that wrote them) so
    comparisons against datetime.now(timezone.utc) don't raise.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=_host_tz()).astimezone(timezone.utc)
    return dt.astimezone(timezone.utc)


def _add_months(dt: datetime, months: int) -> datetime:
    """Add months preserving day-of-month, clamping only if the target month
    is shorter (e.g. Jan 31 + 1mo → Feb 28/29). Wall-clock arithmetic; the
    caller is responsible for tz attachment.
    """
    total = dt.month - 1 + months
    year = dt.year + total // 12
    month = total % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def _js_weekday(d: datetime) -> int:
    """Frontend uses JS getDay() convention (Sun=0..Sat=6). Python's
    datetime.weekday() is Mon=0..Sun=6. Wire format stays JS-style so the
    on_days array round-trips between FE and BE without translation in two
    places."""
    return (d.weekday() + 1) % 7


def _next_fire_after(sched: ScheduleConfig, ref_utc: datetime) -> Optional[datetime]:
    if not sched.enabled:
        return None
    tz = _resolve_tz(sched.timezone)
    ref_local = ref_utc.astimezone(tz)
    base = ref_local.replace(second=0, microsecond=0)

    if sched.repeat_unit == "minute":
        step = max(15, sched.repeat_every)
        c = base
        while c <= ref_local:
            c = c + timedelta(minutes=step)
        return c.astimezone(timezone.utc)

    if sched.repeat_unit == "hour":
        step = max(1, sched.repeat_every)
        c = base.replace(minute=sched.minute)
        while c <= ref_local:
            c = c + timedelta(hours=step)
        return c.astimezone(timezone.utc)

    candidate = base.replace(hour=sched.hour, minute=sched.minute)
    if candidate <= ref_local:
        candidate = candidate + timedelta(days=1)

    if sched.repeat_unit == "day":
        step = max(1, sched.repeat_every)
        # Walk forward in step-day increments until we find a slot strictly
        # after `ref_local`. Cheap because step is small.
        while candidate <= ref_local:
            candidate = candidate + timedelta(days=step)
        return candidate.astimezone(timezone.utc)

    if sched.repeat_unit == "week":
        allowed = sched.on_days or [_js_weekday(ref_local)]
        for _ in range(0, 14):
            if _js_weekday(candidate) in allowed and candidate > ref_local:
                return candidate.astimezone(timezone.utc)
            candidate = candidate + timedelta(days=1)
        return candidate.astimezone(timezone.utc)

    if sched.repeat_unit == "month":
        target_day = ref_local.day
        step = max(1, sched.repeat_every)
        c = candidate.replace(day=min(target_day, calendar.monthrange(candidate.year, candidate.month)[1]))
        while c <= ref_local:
            c = _add_months(c, step)
        return c.astimezone(timezone.utc)

    return None


def compute_next_fire(wf: Workflow, ref: Optional[datetime] = None) -> Optional[datetime]:
    ref_utc = _as_utc(ref) if ref is not None else datetime.now(timezone.utc)
    return _next_fire_after(wf.schedule, ref_utc)


def fires_in_window(wf: Workflow, days: int = 30) -> int:
    """Count fires from now through `days` days from now. Used by the
    cost-estimate response. Honors end conditions so the projection doesn't
    over-count after ends_at or max_runs. Caps the walk at 5000 fires: a
    15-minute schedule fires ~2880x in 30 days, so the cap has to clear that
    to keep the estimate honest while still bounding the loop.
    """
    sched = wf.schedule
    if not sched.enabled:
        return 0
    if sched.max_runs is not None and sched.runs_count >= sched.max_runs:
        return 0
    cursor_utc = datetime.now(timezone.utc)
    end_utc = cursor_utc + timedelta(days=days)
    ends_at_utc = _as_utc(sched.ends_at)
    if ends_at_utc is not None and ends_at_utc < end_utc:
        end_utc = ends_at_utc
    remaining_budget = (
        sched.max_runs - sched.runs_count if sched.max_runs is not None else 5000
    )
    count = 0
    while count < min(5000, remaining_budget):
        nxt = _next_fire_after(sched, cursor_utc)
        if nxt is None or nxt > end_utc:
            break
        count += 1
        cursor_utc = nxt
    return count


def kick() -> None:
    _wake.set()


def _end_condition_hit(wf: Workflow, now_utc: datetime) -> bool:
    s = wf.schedule
    ends_at = _as_utc(s.ends_at)
    if ends_at is not None and now_utc >= ends_at:
        return True
    if s.max_runs is not None and s.runs_count >= s.max_runs:
        return True
    return False


def _disable_schedule(wf: Workflow) -> None:
    wf.schedule.enabled = False
    wf.next_run_at = None
    storage.save_workflow(wf)


async def _tick() -> None:
    now_utc = datetime.now(timezone.utc)
    if storage.get_paused():
        return
    due: list[Workflow] = []
    for wf in storage.list_workflows():
        if not wf.schedule.enabled:
            continue
        if _end_condition_hit(wf, now_utc):
            _disable_schedule(wf)
            continue
        nra = _as_utc(wf.next_run_at)
        if nra and nra <= now_utc:
            due.append(wf)

    for wf in due:
        scheduled_for = _as_utc(wf.next_run_at)
        nxt = _next_fire_after(wf.schedule, now_utc)
        wf.next_run_at = nxt
        storage.save_workflow(wf)
        asyncio.create_task(_fire(wf, scheduled_for=scheduled_for))


async def _fire(wf: Workflow, scheduled_for: Optional[datetime]) -> None:
    try:
        await executor.execute(wf, triggered_by="schedule", scheduled_for=scheduled_for)
    except Exception:
        logger.exception("scheduler fire failed for workflow=%s", wf.id)


def _seconds_until_next() -> float:
    now_utc = datetime.now(timezone.utc)
    soonest: Optional[datetime] = None
    for wf in storage.list_workflows():
        if not wf.schedule.enabled:
            continue
        nra = _as_utc(wf.next_run_at)
        if nra is None:
            continue
        if soonest is None or nra < soonest:
            soonest = nra
    if soonest is None:
        return 60.0
    delta = (soonest - now_utc).total_seconds()
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
                storage.update_run(
                    r.id,
                    status="failure",
                    error="OpenSwarm closed before this run finished.",
                    finished_at=now,
                )


def reconcile_on_startup() -> None:
    """Walk persisted workflows once and resolve missed fires per policy.

    Missed-run policies:
      skip      -> roll forward to next future fire, ignore missed
      run_once  -> if any fires were missed, schedule a single catch-up at now
      run_all   -> not actually run_all in v1 (would burn tokens); same as run_once
                   but we mark the run.status as ran_late so the UI surfaces it
    """
    now_utc = datetime.now(timezone.utc)
    for wf in storage.list_workflows():
        if not wf.schedule.enabled:
            wf.next_run_at = None
            storage.save_workflow(wf)
            continue

        if _end_condition_hit(wf, now_utc):
            _disable_schedule(wf)
            continue

        nra = _as_utc(wf.next_run_at)
        missed = bool(nra and nra <= now_utc)
        if missed and wf.schedule.on_missed in ("run_once", "run_all"):
            # Keep next_run_at <= now_utc so the very next tick fires it.
            # Normalize to a UTC-aware value so future comparisons don't
            # trip on naive legacy datetimes.
            wf.next_run_at = nra
            storage.save_workflow(wf)
        else:
            wf.next_run_at = _next_fire_after(wf.schedule, now_utc)
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


def list_active() -> list[dict]:
    """Snapshot of currently-running workflow runs.

    Reads executor._running (workflow_id -> run_id) and joins against the
    workflow cache for titles. Used by GET /workflows/active so the tray
    and the auto-updater veto can both ask "are any runs in flight?"
    without holding the executor lock.
    """
    out: list[dict] = []
    snapshot = dict(executor._running)
    for wid, run_id in snapshot.items():
        wf = storage.get_workflow(wid)
        title = wf.title if wf else ""
        started_at = None
        if wf:
            for r in storage.list_runs(wid, limit=10):
                if r.id == run_id:
                    started_at = r.started_at.isoformat() if isinstance(r.started_at, datetime) else r.started_at
                    break
        out.append({
            "workflow_id": wid,
            "run_id": run_id,
            "title": title,
            "started_at": started_at,
        })
    return out
