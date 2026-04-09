import asyncio
import logging
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

_scheduler_task: asyncio.Task | None = None
TICK_INTERVAL = 30


async def _tick():
    """One evaluation cycle: check all enabled schedules, fire due ones."""
    from backend.apps.schedules.schedules import _load_all, _save
    from backend.apps.schedules.executor import execute_schedule

    now = datetime.now()
    for schedule in _load_all():
        if not schedule.enabled:
            continue
        if schedule.next_run_at is None:
            continue
        if schedule.next_run_at > now:
            continue

        try:
            await execute_schedule(schedule)
            schedule.last_run_at = now
            schedule.run_count += 1
            schedule.last_error = None

            from backend.apps.agents.ws_manager import ws_manager
            await ws_manager.broadcast_global("schedule:run_complete", {
                "schedule_id": schedule.id,
                "name": schedule.name,
            })
        except Exception as e:
            logger.exception(f"Schedule {schedule.id} ({schedule.name}) failed")
            schedule.last_error = str(e)

            from backend.apps.agents.ws_manager import ws_manager
            await ws_manager.broadcast_global("schedule:run_failed", {
                "schedule_id": schedule.id,
                "name": schedule.name,
                "error": str(e),
            })

        schedule.next_run_at = _compute_next_run(schedule, now)

        if schedule.trigger_type == "once":
            schedule.enabled = False

        schedule.updated_at = now
        _save(schedule)


def _compute_next_run(schedule, after: datetime) -> datetime | None:
    """Compute the next run time based on trigger type."""
    if schedule.trigger_type == "cron" and schedule.cron_expression:
        from croniter import croniter
        return croniter(schedule.cron_expression, after).get_next(datetime)
    elif schedule.trigger_type == "interval" and schedule.interval_seconds:
        return after + timedelta(seconds=schedule.interval_seconds)
    elif schedule.trigger_type == "once":
        return None
    return None


def compute_initial_next_run(schedule) -> datetime | None:
    """Compute the first next_run_at when a schedule is created."""
    if schedule.trigger_type == "cron" and schedule.cron_expression:
        from croniter import croniter
        return croniter(schedule.cron_expression, datetime.now()).get_next(datetime)
    elif schedule.trigger_type == "interval" and schedule.interval_seconds:
        return datetime.now() + timedelta(seconds=schedule.interval_seconds)
    elif schedule.trigger_type == "once" and schedule.run_at:
        return schedule.run_at
    return None


async def _run_loop():
    """Main scheduler loop — ticks every TICK_INTERVAL seconds."""
    while True:
        try:
            await _tick()
        except Exception:
            logger.exception("Scheduler tick failed")
        await asyncio.sleep(TICK_INTERVAL)


def start_scheduler():
    """Start the background scheduler task."""
    global _scheduler_task
    if _scheduler_task is None or _scheduler_task.done():
        loop = asyncio.get_event_loop()
        _scheduler_task = loop.create_task(_run_loop())
        logger.info("Scheduler started (tick interval: %ds)", TICK_INTERVAL)


def stop_scheduler():
    """Stop the background scheduler task."""
    global _scheduler_task
    if _scheduler_task and not _scheduler_task.done():
        _scheduler_task.cancel()
        _scheduler_task = None
        logger.info("Scheduler stopped")
