import json
import os
import logging
from contextlib import asynccontextmanager
from datetime import datetime

from backend.config.Apps import SubApp
from backend.apps.schedules.models import Schedule, ScheduleCreate, ScheduleUpdate
from backend.apps.schedules.scheduler import start_scheduler, stop_scheduler, compute_initial_next_run
from backend.config.paths import SCHEDULES_DIR as DATA_DIR
from fastapi import HTTPException, Query

logger = logging.getLogger(__name__)


def _load_all() -> list[Schedule]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(DATA_DIR, fname)) as f:
                result.append(Schedule(**json.load(f)))
    return result


def _save(schedule: Schedule):
    with open(os.path.join(DATA_DIR, f"{schedule.id}.json"), "w") as f:
        json.dump(schedule.model_dump(mode="json"), f, indent=2)


def _load(schedule_id: str) -> Schedule:
    path = os.path.join(DATA_DIR, f"{schedule_id}.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Schedule not found")
    with open(path) as f:
        return Schedule(**json.load(f))


def _delete(schedule_id: str):
    path = os.path.join(DATA_DIR, f"{schedule_id}.json")
    if os.path.exists(path):
        os.remove(path)


def delete_schedules_for_dashboard(dashboard_id: str):
    """Remove all schedules tied to a dashboard. Called during dashboard deletion."""
    for schedule in _load_all():
        if schedule.dashboard_id == dashboard_id:
            _delete(schedule.id)
            logger.info(f"Deleted schedule {schedule.id} (dashboard {dashboard_id} deleted)")


@asynccontextmanager
async def schedules_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    start_scheduler()
    try:
        yield
    finally:
        stop_scheduler()


schedules = SubApp("schedules", schedules_lifespan)


@schedules.router.get("/list")
async def list_schedules(dashboard_id: str | None = Query(None)):
    all_schedules = _load_all()
    if dashboard_id:
        all_schedules = [s for s in all_schedules if s.dashboard_id == dashboard_id]
    all_schedules.sort(key=lambda s: s.updated_at or s.created_at, reverse=True)
    return {"schedules": [s.model_dump(mode="json") for s in all_schedules]}


@schedules.router.post("/create")
async def create_schedule(body: ScheduleCreate):
    schedule = Schedule(
        name=body.name,
        dashboard_id=body.dashboard_id,
        trigger_type=body.trigger_type,
        cron_expression=body.cron_expression,
        interval_seconds=body.interval_seconds,
        run_at=body.run_at,
        action_type=body.action_type,
        prompt=body.prompt,
        target_session_id=body.target_session_id,
        template_id=body.template_id,
        model=body.model,
        mode=body.mode,
        system_prompt=body.system_prompt,
    )
    schedule.next_run_at = compute_initial_next_run(schedule)
    _save(schedule)
    return schedule.model_dump(mode="json")


@schedules.router.get("/{schedule_id}")
async def get_schedule(schedule_id: str):
    return _load(schedule_id).model_dump(mode="json")


@schedules.router.put("/{schedule_id}")
async def update_schedule(schedule_id: str, body: ScheduleUpdate):
    schedule = _load(schedule_id)
    trigger_changed = False

    for field_name in body.model_fields_set:
        value = getattr(body, field_name)
        setattr(schedule, field_name, value)
        if field_name in ("trigger_type", "cron_expression", "interval_seconds", "run_at"):
            trigger_changed = True

    if trigger_changed:
        schedule.next_run_at = compute_initial_next_run(schedule)

    schedule.updated_at = datetime.now()
    _save(schedule)
    return schedule.model_dump(mode="json")


@schedules.router.delete("/{schedule_id}")
async def delete_schedule_endpoint(schedule_id: str):
    _load(schedule_id)  # 404 if not found
    _delete(schedule_id)
    return {"ok": True}


@schedules.router.post("/{schedule_id}/toggle")
async def toggle_schedule(schedule_id: str):
    schedule = _load(schedule_id)
    schedule.enabled = not schedule.enabled

    if schedule.enabled and schedule.next_run_at is None:
        schedule.next_run_at = compute_initial_next_run(schedule)

    schedule.updated_at = datetime.now()
    _save(schedule)
    return schedule.model_dump(mode="json")
