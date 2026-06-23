"""In-process cron-style scheduler.

One long-lived asyncio task wakes on the next-due workflow boundary, fires
matching workflows, then re-computes. We deliberately avoid one-task-per-
workflow (turns rescheduling into a thundering re-spawn problem). On
startup we walk persisted workflows once and capture every fire that
elapsed while the app was closed as a pending MissedRun, so the launch-time
review card can let the user run or dismiss each one.

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

from backend.apps.workflows.models import Workflow, ScheduleConfig, WorkflowRun, MissedRun
from backend.apps.workflows import storage, executor

logger = logging.getLogger(__name__)

# How many recent missed fires we keep reviewable per workflow. Older ones
# collapse into a single summarizing "skipped" run so a 15-minute schedule
# that was off for days doesn't flood the card or the run history.
PER_WORKFLOW_MISSED_CAP = 20
# Bound on the per-workflow enumeration walk at startup. 480 covers ~5 days of
# a 15-minute schedule; past that the exact count stops mattering.
MISSED_ENUM_CAP = 480


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


def host_timezone_name() -> str:
    """Concrete IANA-ish zone name for schedules created on this host."""
    return getattr(_host_tz(), "key", None) or "UTC"


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


def _week_start(d: datetime) -> datetime:
    return (d - timedelta(days=_js_weekday(d))).replace(hour=0, minute=0, second=0, microsecond=0)


def _js_weekday(d: datetime) -> int:
    """Frontend uses JS getDay() convention (Sun=0..Sat=6). Python's
    datetime.weekday() is Mon=0..Sun=6. Wire format stays JS-style so the
    on_days array round-trips between FE and BE without translation in two
    places."""
    return (d.weekday() + 1) % 7


def is_schedule_configured(sched: ScheduleConfig) -> bool:
    if sched.repeat_unit == "week":
        return bool(sched.on_days)
    return True


def p_first_after(anchor: datetime, ref: datetime, step: timedelta) -> datetime:
    """First instant on the grid {anchor + k*step} strictly after ref."""
    if anchor > ref:
        return anchor
    n = (ref - anchor) // step
    return anchor + (n + 1) * step


def _next_fire_after(
    sched: ScheduleConfig,
    ref_utc: datetime,
    anchor_utc: Optional[datetime] = None,
) -> Optional[datetime]:
    if not sched.enabled or not is_schedule_configured(sched):
        return None
    tz = _resolve_tz(sched.timezone)
    ref_local = ref_utc.astimezone(tz)
    base = ref_local.replace(second=0, microsecond=0)
    # Anchor recurring phases to a fixed origin (the workflow's creation), so a
    # recompute (tick, kick, startup reconcile) lands on the same grid instead
    # of re-phasing to "now" and sliding the cadence. Falls back to ref.
    anchor_local = (anchor_utc or ref_utc).astimezone(tz)

    if sched.repeat_unit == "minute":
        step = max(15, sched.repeat_every)
        grid = anchor_local.replace(second=0, microsecond=0)
        return p_first_after(grid, ref_local, timedelta(minutes=step)).astimezone(timezone.utc)

    if sched.repeat_unit == "hour":
        step = max(1, sched.repeat_every)
        grid = anchor_local.replace(minute=sched.minute, second=0, microsecond=0)
        return p_first_after(grid, ref_local, timedelta(hours=step)).astimezone(timezone.utc)

    candidate = base.replace(hour=sched.hour, minute=sched.minute)

    if sched.repeat_unit == "day":
        step = max(1, sched.repeat_every)
        while candidate <= ref_local:
            candidate = candidate + timedelta(days=step)
        return candidate.astimezone(timezone.utc)

    if sched.repeat_unit == "month":
        target_day = sched.day_of_month or ref_local.day
        step = max(1, sched.repeat_every)

        def month_day(year: int, month: int) -> int:
            last = calendar.monthrange(year, month)[1]
            return last if sched.last_day_of_month else min(target_day, last)

        c = candidate.replace(day=month_day(candidate.year, candidate.month))
        while c <= ref_local:
            total = c.month - 1 + step
            year = c.year + total // 12
            month = total % 12 + 1
            c = c.replace(year=year, month=month, day=month_day(year, month))
        return c.astimezone(timezone.utc)

    if candidate <= ref_local:
        candidate = candidate + timedelta(days=1)

    if sched.repeat_unit == "week":
        allowed = sched.on_days
        step = max(1, sched.repeat_every)
        anchor_week = _week_start(anchor_local)
        for _ in range(0, 7 * step + 7):
            week_delta = (_week_start(candidate).date() - anchor_week.date()).days // 7
            if (
                _js_weekday(candidate) in allowed
                and candidate > ref_local
                and (week_delta == 0 or week_delta % step == 0)
            ):
                return candidate.astimezone(timezone.utc)
            candidate = candidate + timedelta(days=1)
        return candidate.astimezone(timezone.utc)

    return None


def compute_next_fire(wf: Workflow, ref: Optional[datetime] = None) -> Optional[datetime]:
    ref_utc = _as_utc(ref) if ref is not None else datetime.now(timezone.utc)
    return _next_fire_after(wf.schedule, ref_utc, _as_utc(getattr(wf, "created_at", None)))


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
    anchor_utc = _as_utc(getattr(wf, "created_at", None))
    count = 0
    while count < min(5000, remaining_budget):
        nxt = _next_fire_after(sched, cursor_utc, anchor_utc)
        if nxt is None or nxt > end_utc:
            break
        count += 1
        cursor_utc = nxt
    return count


def occurrences_between(
    wf: Workflow,
    from_utc: datetime,
    to_utc: datetime,
    cap: int = 5000,
) -> list[datetime]:
    """Return scheduled fire instants in [from_utc, to_utc).

    Calendar previews must use the same timezone-aware recurrence engine as
    the scheduler. Inputs and outputs are UTC-aware datetimes; callers can
    render those absolute instants in any local timezone.
    """
    sched = wf.schedule
    if not sched.enabled or not is_schedule_configured(sched):
        return []
    if sched.max_runs is not None and sched.runs_count >= sched.max_runs:
        return []
    start_utc = _as_utc(from_utc)
    end_utc = _as_utc(to_utc)
    if start_utc is None or end_utc is None or end_utc <= start_utc:
        return []

    created_at = _as_utc(getattr(wf, "created_at", None))
    cursor_utc = start_utc - timedelta(microseconds=1)
    if created_at is not None and created_at > cursor_utc:
        cursor_utc = created_at

    ends_at = _as_utc(sched.ends_at)
    if ends_at is not None:
        if ends_at <= start_utc:
            return []
        if ends_at < end_utc:
            end_utc = ends_at

    remaining = sched.max_runs - sched.runs_count if sched.max_runs is not None else cap
    limit = max(0, min(cap, remaining))
    out: list[datetime] = []
    while len(out) < limit:
        nxt = _next_fire_after(sched, cursor_utc, created_at)
        if nxt is None or nxt >= end_utc:
            break
        if nxt >= start_utc:
            out.append(nxt.astimezone(timezone.utc))
        cursor_utc = nxt
    return out


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
        if not is_schedule_configured(wf.schedule):
            _disable_schedule(wf)
            continue
        if _end_condition_hit(wf, now_utc):
            _disable_schedule(wf)
            continue
        nra = _as_utc(wf.next_run_at)
        if nra and nra <= now_utc:
            due.append(wf)

    for wf in due:
        scheduled_for = _as_utc(wf.next_run_at)
        nxt = _next_fire_after(wf.schedule, now_utc, _as_utc(getattr(wf, "created_at", None)))
        wf.next_run_at = nxt
        storage.save_workflow(wf)
        asyncio.create_task(_fire(wf, scheduled_for=scheduled_for))


async def _fire(wf: Workflow, scheduled_for: Optional[datetime]) -> None:
    try:
        await executor.execute(wf, triggered_by="schedule", scheduled_for=scheduled_for)
    except Exception:
        logger.exception("scheduler fire failed for workflow=%s", wf.id)


def _seconds_until_next() -> float:
    # While globally paused, _tick no-ops and never rolls next_run_at forward,
    # so an overdue slot would otherwise spin this loop at the 1s floor. Resume
    # calls kick(), so idling the full interval here costs nothing.
    if storage.get_paused():
        return 60.0
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
                    error="Interrupted: OpenSwarm or your computer shut down before this run finished.",
                    finished_at=now,
                )
                # The run row is fixed, but the workflow still summarizes this
                # dead run as 'running' (that's what the detail header reads), so
                # heal the summary too when this was the latest run.
                if wf.last_run_id == r.id and wf.last_run_status == "running":
                    executor._persist_run_fields(wf, {
                        "last_run_status": "failure",
                        "last_run_at": now,
                    })


def record_skipped(wf: Workflow, scheduled_for: datetime, error: str) -> WorkflowRun:
    """Log a missed fire as a 'skipped' run so it leaves a trace in history.

    Used both for over-cap fires at startup and for fires the user dismisses
    from the review card. Updates the workflow's last_run_* summary so the
    card's status dot reflects reality.
    """
    now = datetime.now()
    run = WorkflowRun(
        workflow_id=wf.id,
        status="skipped",
        scheduled_for=scheduled_for,
        started_at=now,
        finished_at=now,
        triggered_by="schedule",
        error=error,
    )
    storage.record_run(run)
    wf.last_run_at = now
    wf.last_run_status = "skipped"
    wf.last_run_id = run.id
    storage.save_workflow(wf)
    return run


def _capture_missed(wf: Workflow, missed: list[datetime]) -> None:
    if not missed:
        return
    recent = missed[-PER_WORKFLOW_MISSED_CAP:]
    older = missed[: len(missed) - len(recent)]
    if older:
        suffix = "+" if len(missed) >= MISSED_ENUM_CAP else ""
        record_skipped(
            wf,
            older[0],
            f"Skipped {len(older)}{suffix} earlier missed runs while OpenSwarm was closed",
        )
    for sf in recent:
        storage.add_missed(MissedRun(workflow_id=wf.id, scheduled_for=sf))


async def run_missed_sequence(wf: Workflow, scheduled_fors: list[datetime]) -> None:
    """Run a workflow once per missed fire, sequentially.

    Sequential because the executor refuses concurrent runs of the same
    workflow; firing them all at once would skip all but the first.
    """
    for sf in scheduled_fors:
        try:
            await executor.execute(wf, triggered_by="schedule", scheduled_for=sf)
        except Exception:
            logger.exception("missed-run fire failed for workflow=%s", wf.id)


def reconcile_on_startup() -> None:
    """Walk persisted workflows once and capture fires missed while closed.

    No auto-firing here anymore: each missed fire becomes a pending MissedRun
    the user reviews on launch. We roll next_run_at forward to a future slot so
    a dev hot-reload re-running this won't re-enumerate the same misses.
    """
    now_utc = datetime.now(timezone.utc)
    for wf in storage.list_workflows():
        if not wf.schedule.enabled:
            wf.next_run_at = None
            storage.save_workflow(wf)
            continue

        if not is_schedule_configured(wf.schedule):
            _disable_schedule(wf)
            continue

        if _end_condition_hit(wf, now_utc):
            _disable_schedule(wf)
            continue

        anchor = _as_utc(wf.next_run_at)
        if anchor is not None and anchor <= now_utc:
            _capture_missed(wf, occurrences_between(wf, anchor, now_utc, cap=MISSED_ENUM_CAP))

        wf.next_run_at = _next_fire_after(wf.schedule, now_utc, _as_utc(getattr(wf, "created_at", None)))
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
