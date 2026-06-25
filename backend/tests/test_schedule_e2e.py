"""End-to-end smoke: does a scheduled workflow actually fire when its
time hits, with the full scheduler loop running?

Runs the real scheduler.start() loop with the executor mocked so we
don't need a live agent_manager. Then arms a workflow whose
next_run_at is one second in the future, waits, and asserts the
mocked executor was called.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_schedule_e2e.py -v
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

import pytest

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def isolated_data_dir(monkeypatch, tmp_path):
    from backend.apps.workflows import storage as _storage
    from backend.apps.workflows import escalation as _escalation
    from backend.apps.workflows import audit as _audit
    from backend.apps.workflows import scheduler as _scheduler
    monkeypatch.setattr(_storage, "DATA_DIR", str(tmp_path / "workflows"))
    monkeypatch.setattr(_storage, "RUNS_DIR", str(tmp_path / "workflows" / "runs"))
    monkeypatch.setattr(_storage, "PAUSED_FILE", str(tmp_path / "workflows" / "paused.json"))
    monkeypatch.setattr(_storage, "MISSED_FILE", str(tmp_path / "workflows" / "missed.json"))
    monkeypatch.setattr(_storage, "_workflow_cache", {})
    monkeypatch.setattr(_storage, "_runs_cache", {})
    monkeypatch.setattr(_storage, "_missed_cache", [])
    monkeypatch.setattr(_storage, "_cache_loaded", False)
    monkeypatch.setattr(_storage, "_paused", False)
    monkeypatch.setattr(_audit, "AUDIT_DIR", str(tmp_path / "workflows" / "audit"))
    # Module-level scheduler state survives across tests; reset it so each test gets a fresh _wake Event bound to its own event loop.
    _scheduler._loop_task = None
    _scheduler._wake = asyncio.Event()
    _escalation._tasks.clear()
    _escalation._state.clear()
    yield


def _make_wf(**overrides):
    from backend.apps.workflows.models import Workflow, ScheduleConfig, WorkflowStep
    base = dict(
        title="smoke",
        steps=[WorkflowStep(text="hi")],
        schedule=ScheduleConfig(
            enabled=True, repeat_unit="day", repeat_every=1,
            hour=9, minute=0, timezone="America/Los_Angeles",
        ),
    )
    base.update(overrides)
    return Workflow(**base)


async def test_loop_fires_due_workflow(monkeypatch):
    """Arm a workflow to fire ~now and assert the executor was actually
    invoked by the scheduler loop within the test window. Note the save
    happens AFTER scheduler.start() so reconcile_on_startup doesn't
    clobber next_run_at."""
    from backend.apps.workflows import storage, scheduler, executor

    fired = asyncio.Event()
    captured: dict = {}

    async def fake_execute(wf, triggered_by="schedule", scheduled_for=None):
        captured["wf_id"] = wf.id
        captured["triggered_by"] = triggered_by
        captured["scheduled_for"] = scheduled_for
        from backend.apps.workflows.models import WorkflowRun
        run = WorkflowRun(
            workflow_id=wf.id,
            status="success",
            scheduled_for=scheduled_for,
            started_at=datetime.now(timezone.utc),
            finished_at=datetime.now(timezone.utc),
            triggered_by=triggered_by,
        )
        storage.record_run(run)
        fired.set()
        return run

    monkeypatch.setattr(executor, "execute", fake_execute)

    await scheduler.start()
    try:
        wf = _make_wf()
        wf.next_run_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        storage.save_workflow(wf)
        scheduler.kick()  # force immediate tick
        # Wait up to 5s for the fire to land.
        await asyncio.wait_for(fired.wait(), timeout=5.0)
    finally:
        await scheduler.stop()

    assert captured.get("wf_id") == wf.id
    assert captured.get("triggered_by") == "schedule"
    runs = storage.list_runs(wf.id, limit=10)
    assert len(runs) == 1
    assert runs[0].status == "success"
    # Scheduler should have rolled next_run_at forward to a future slot.
    after = storage.get_workflow(wf.id)
    assert after.next_run_at is not None
    assert after.next_run_at > datetime.now(timezone.utc)


async def test_disabled_workflow_does_not_fire(monkeypatch):
    """Master switch off => loop never invokes the executor even if
    next_run_at is in the past."""
    from backend.apps.workflows import storage, scheduler, executor

    fake = AsyncMock()
    monkeypatch.setattr(executor, "execute", fake)

    wf = _make_wf()
    wf.schedule.enabled = False
    wf.next_run_at = datetime.now(timezone.utc) - timedelta(seconds=10)
    storage.save_workflow(wf)

    await scheduler.start()
    try:
        scheduler.kick()
        await asyncio.sleep(2.0)
    finally:
        await scheduler.stop()
    fake.assert_not_called()


async def test_paused_state_blocks_all_fires(monkeypatch):
    """Global pause flag wins over per-workflow enabled state."""
    from backend.apps.workflows import storage, scheduler, executor

    fake = AsyncMock()
    monkeypatch.setattr(executor, "execute", fake)

    wf = _make_wf()
    wf.next_run_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    storage.save_workflow(wf)
    storage.set_paused(True)

    await scheduler.start()
    try:
        scheduler.kick()
        await asyncio.sleep(2.0)
    finally:
        await scheduler.stop()
    fake.assert_not_called()
    storage.set_paused(False)


async def test_reconcile_captures_missed_fires(monkeypatch):
    """A daily workflow whose next_run_at elapsed while the app was closed =>
    startup captures the missed fires as pending MissedRuns and rolls
    next_run_at forward (no auto-firing)."""
    from backend.apps.workflows import storage, scheduler
    # created_at must predate the missed window; occurrences_between never enumerates fires from before the workflow existed.
    wf = _make_wf(created_at=datetime.now(timezone.utc) - timedelta(days=10))
    wf.next_run_at = datetime.now(timezone.utc) - timedelta(days=3)
    storage.save_workflow(wf)
    scheduler.reconcile_on_startup()
    missed = [m for m in storage.list_missed() if m.workflow_id == wf.id]
    assert len(missed) >= 1
    assert all(m.scheduled_for < datetime.now(timezone.utc) for m in missed)
    after = storage.get_workflow(wf.id)
    assert after.next_run_at is not None
    assert after.next_run_at > datetime.now(timezone.utc)


async def test_reconcile_no_missed_when_future(monkeypatch):
    """next_run_at in the future => nothing missed, nothing captured."""
    from backend.apps.workflows import storage, scheduler
    wf = _make_wf(created_at=datetime.now(timezone.utc) - timedelta(days=10))
    wf.next_run_at = datetime.now(timezone.utc) + timedelta(hours=6)
    storage.save_workflow(wf)
    scheduler.reconcile_on_startup()
    assert [m for m in storage.list_missed() if m.workflow_id == wf.id] == []


async def test_reconcile_over_cap_collapses_to_skipped(monkeypatch):
    """A 15-minute schedule off for days => only the cap is kept reviewable;
    the rest collapse into a single skipped run in history."""
    from backend.apps.workflows import storage, scheduler
    from backend.apps.workflows.models import ScheduleConfig
    wf = _make_wf(
        created_at=datetime.now(timezone.utc) - timedelta(days=30),
        schedule=ScheduleConfig(
            enabled=True, repeat_unit="minute", repeat_every=15,
            timezone="America/Los_Angeles",
        ),
    )
    wf.next_run_at = datetime.now(timezone.utc) - timedelta(days=2)
    storage.save_workflow(wf)
    scheduler.reconcile_on_startup()
    missed = [m for m in storage.list_missed() if m.workflow_id == wf.id]
    assert len(missed) == scheduler.PER_WORKFLOW_MISSED_CAP
    skipped = [r for r in storage.list_runs(wf.id, limit=50) if r.status == "skipped"]
    assert len(skipped) == 1


async def test_dismiss_missed_records_skipped(monkeypatch):
    """Dismissing a missed run drops it from pending and leaves a skipped
    run in history."""
    from backend.apps.workflows import storage
    from backend.apps.workflows.models import MissedRun, MissedRunAction
    from backend.apps.workflows.workflows import dismiss_missed_runs
    wf = _make_wf()
    storage.save_workflow(wf)
    m = MissedRun(workflow_id=wf.id, scheduled_for=datetime.now(timezone.utc) - timedelta(hours=2))
    storage.add_missed(m)
    res = await dismiss_missed_runs(MissedRunAction(ids=[m.id]))
    assert res["dismissed"] == 1
    assert storage.list_missed() == []
    skipped = [r for r in storage.list_runs(wf.id, limit=10) if r.status == "skipped"]
    assert len(skipped) == 1


async def test_run_missed_runs_clears_pending_and_fires(monkeypatch):
    """Running selected missed fires removes them from pending and invokes
    the executor once per fire, sequentially."""
    from backend.apps.workflows import storage, executor, scheduler
    from backend.apps.workflows.models import MissedRun, MissedRunAction
    from backend.apps.workflows.workflows import run_missed_runs

    calls: list = []

    async def fake_execute(wf, triggered_by="schedule", scheduled_for=None):
        calls.append(scheduled_for)
        from backend.apps.workflows.models import WorkflowRun
        return WorkflowRun(workflow_id=wf.id, status="ran_late", scheduled_for=scheduled_for)

    monkeypatch.setattr(executor, "execute", fake_execute)

    wf = _make_wf()
    storage.save_workflow(wf)
    m1 = MissedRun(workflow_id=wf.id, scheduled_for=datetime.now(timezone.utc) - timedelta(hours=3))
    m2 = MissedRun(workflow_id=wf.id, scheduled_for=datetime.now(timezone.utc) - timedelta(hours=2))
    storage.add_missed(m1)
    storage.add_missed(m2)
    res = await run_missed_runs(MissedRunAction(ids=[m1.id, m2.id]))
    assert res["started"] == 2
    assert storage.list_missed() == []
    # The endpoint spawns the sequence as a background task; give it a beat.
    await asyncio.sleep(0.05)
    assert len(calls) == 2


async def test_create_workflow_schedules_next_fire():
    """POST-like create path: enabled schedule => next_run_at populated
    by compute_next_fire."""
    from backend.apps.workflows.models import Workflow, ScheduleConfig, WorkflowStep
    from backend.apps.workflows import scheduler
    wf = Workflow(
        title="t",
        steps=[WorkflowStep(text="hi")],
        schedule=ScheduleConfig(
            enabled=True, repeat_unit="week", repeat_every=1, on_days=[0],
            hour=9, minute=0, timezone="America/Los_Angeles",
        ),
    )
    nxt = scheduler.compute_next_fire(wf)
    assert nxt is not None
    assert nxt > datetime.now(timezone.utc)
    tz = ZoneInfo("America/Los_Angeles")
    local = nxt.astimezone(tz)
    assert local.weekday() == 6  # Python: Sunday
    assert (local.hour, local.minute) == (9, 0)


async def test_next_run_at_advances_after_fire(monkeypatch):
    """After a fire the loop should re-compute next_run_at into the
    future and persist it, so the same fire can't repeat in the same
    minute."""
    from backend.apps.workflows import storage, scheduler, executor

    fired = asyncio.Event()

    async def fake_execute(wf, triggered_by="schedule", scheduled_for=None):
        from backend.apps.workflows.models import WorkflowRun
        run = WorkflowRun(
            workflow_id=wf.id, status="success", scheduled_for=scheduled_for,
            started_at=datetime.now(timezone.utc), finished_at=datetime.now(timezone.utc),
            triggered_by=triggered_by,
        )
        storage.record_run(run)
        fired.set()
        return run

    monkeypatch.setattr(executor, "execute", fake_execute)

    await scheduler.start()
    try:
        wf = _make_wf()
        armed_at = datetime.now(timezone.utc) + timedelta(seconds=1)
        wf.next_run_at = armed_at
        storage.save_workflow(wf)
        scheduler.kick()
        await asyncio.wait_for(fired.wait(), timeout=5.0)
        # Give the loop one extra tick to persist next_run_at.
        await asyncio.sleep(0.2)
    finally:
        await scheduler.stop()

    after = storage.get_workflow(wf.id)
    assert after.next_run_at is not None
    assert after.next_run_at > armed_at, "scheduler did not advance next_run_at past the slot it just fired"


async def test_kick_wakes_loop_before_timeout(monkeypatch):
    """kick() should wake the loop early so manual schedule edits don't
    have to wait a full minute for the next tick boundary."""
    from backend.apps.workflows import storage, scheduler, executor

    fired = asyncio.Event()

    async def fake_execute(wf, triggered_by="schedule", scheduled_for=None):
        from backend.apps.workflows.models import WorkflowRun
        run = WorkflowRun(
            workflow_id=wf.id, status="success",
            started_at=datetime.now(timezone.utc),
            finished_at=datetime.now(timezone.utc), triggered_by=triggered_by,
        )
        storage.record_run(run)
        fired.set()
        return run

    monkeypatch.setattr(executor, "execute", fake_execute)

    await scheduler.start()
    try:
        wf = _make_wf()
        wf.next_run_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        storage.save_workflow(wf)
        scheduler.kick()
        # Without kick(), the loop would sleep up to 60s before checking the freshly-saved workflow. With kick, it should fire fast.
        await asyncio.wait_for(fired.wait(), timeout=3.0)
    finally:
        await scheduler.stop()


async def test_last_day_of_month_fires_on_month_end():
    """last_day_of_month ignores day_of_month and lands on the calendar's
    final day, so it survives short months (Feb) instead of clamping."""
    from backend.apps.workflows.models import ScheduleConfig
    from backend.apps.workflows import scheduler
    sched = ScheduleConfig(
        enabled=True, repeat_unit="month", repeat_every=1,
        day_of_month=15, last_day_of_month=True, hour=9, minute=0,
        timezone="America/Los_Angeles",
    )
    wf = _make_wf(schedule=sched)
    tz = ZoneInfo("America/Los_Angeles")
    # From mid-February, the next fire is Feb 28 (or 29 on a leap year), NOT the 15th.
    ref = datetime(2026, 2, 10, 12, 0, tzinfo=tz).astimezone(timezone.utc)
    nxt = scheduler.compute_next_fire(wf, ref=ref)
    local = nxt.astimezone(tz)
    assert local.month == 2 and local.day == 28
    assert local.hour == 9
    # From end of Feb, the following fire rolls to Mar 31 (last day again).
    nxt2 = scheduler.compute_next_fire(wf, ref=nxt)
    local2 = nxt2.astimezone(tz)
    assert local2.month == 3 and local2.day == 31


async def test_soft_deleted_excluded_from_list():
    """Soft-deleted workflows drop out of list_workflows (so the scheduler and
    every list view skip them) but stay visible to list_deleted_workflows."""
    from backend.apps.workflows import storage
    live = _make_wf(title="live")
    trashed = _make_wf(title="trashed")
    trashed.deleted_at = datetime.now()
    storage.save_workflow(live)
    storage.save_workflow(trashed)
    active_ids = {w.id for w in storage.list_workflows()}
    deleted_ids = {w.id for w in storage.list_deleted_workflows()}
    assert live.id in active_ids and trashed.id not in active_ids
    assert trashed.id in deleted_ids and live.id not in deleted_ids
    # get_workflow still resolves a trashed record so restore/purge can fetch it.
    assert storage.get_workflow(trashed.id) is not None
