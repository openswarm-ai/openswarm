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
    monkeypatch.setattr(_storage, "_workflow_cache", {})
    monkeypatch.setattr(_storage, "_runs_cache", {})
    monkeypatch.setattr(_storage, "_cache_loaded", False)
    monkeypatch.setattr(_storage, "_paused", False)
    monkeypatch.setattr(_audit, "AUDIT_DIR", str(tmp_path / "workflows" / "audit"))
    # Module-level scheduler state survives across tests; reset it so
    # each test gets a fresh _wake Event bound to its own event loop.
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


async def test_reconcile_skip_rolls_past_missed(monkeypatch):
    """on_missed='skip' + a missed next_run_at => startup rolls forward
    to the next future fire without queuing a catch-up."""
    from backend.apps.workflows import storage, scheduler
    wf = _make_wf()
    wf.schedule.on_missed = "skip"
    # Stash a missed fire 6 hours ago.
    wf.next_run_at = datetime.now(timezone.utc) - timedelta(hours=6)
    storage.save_workflow(wf)
    scheduler.reconcile_on_startup()
    after = storage.get_workflow(wf.id)
    assert after.next_run_at is not None
    assert after.next_run_at > datetime.now(timezone.utc)


async def test_reconcile_run_once_keeps_missed(monkeypatch):
    """on_missed='run_once' => startup leaves next_run_at in the past so
    the first tick fires a catch-up."""
    from backend.apps.workflows import storage, scheduler
    wf = _make_wf()
    wf.schedule.on_missed = "run_once"
    missed = datetime.now(timezone.utc) - timedelta(hours=6)
    wf.next_run_at = missed
    storage.save_workflow(wf)
    scheduler.reconcile_on_startup()
    after = storage.get_workflow(wf.id)
    assert after.next_run_at <= datetime.now(timezone.utc)


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
        # Without kick(), the loop would sleep up to 60s before checking
        # the freshly-saved workflow. With kick, it should fire fast.
        await asyncio.wait_for(fired.wait(), timeout=3.0)
    finally:
        await scheduler.stop()
