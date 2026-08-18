"""Claim-time status gate + the OQ-17 scheduler guard (BUILD_PLAN W1, task T26).

Complements test_scheduled_stop_on_pause_trash.py (the per-step recheck): these cover the
QUEUED-fire race — the scheduler creates the _fire task against a point-in-time list, so a
workflow trashed/paused after queueing must record a clean "skipped" without ever creating
an agent session. Plus the OPENSWARM_SCHEDULER_ENABLED guard: a non-designated instance must
not run the loop or the stuck-run reaper (which would kill a peer's live runs).
"""

from __future__ import annotations

import asyncio
from datetime import datetime

import pytest


@pytest.fixture(autouse=True)
def p_wf_env(isolated_workflows_data, reset_scheduler_state):
    yield


def p_run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_queued_schedule_fire_skips_when_workflow_already_trashed(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    stored = storage.get_workflow(wf.id)
    stored.deleted_at = datetime.now()
    storage.save_workflow(stored)

    run = p_run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "skipped"
    assert run.error == "Workflow deleted"
    assert fake_agent_manager.sent_messages == []  # no session, no steps


def test_queued_manual_fire_of_trashed_workflow_also_skips(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    stored = storage.get_workflow(wf.id)
    stored.deleted_at = datetime.now()
    storage.save_workflow(stored)

    run = p_run(executor.execute(wf, triggered_by="manual"))
    assert run.status == "skipped"
    assert fake_agent_manager.sent_messages == []


def test_queued_schedule_fire_skips_when_schedule_disabled(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    stored = storage.get_workflow(wf.id)
    stored.schedule.enabled = False
    storage.save_workflow(stored)

    run = p_run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "skipped"
    assert run.error == "Workflow is paused"
    assert fake_agent_manager.sent_messages == []


def test_queued_schedule_fire_skips_when_globally_paused(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    storage.set_paused(True)

    run = p_run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "skipped"
    assert run.error == "All schedules are paused"
    assert fake_agent_manager.sent_messages == []


def test_manual_fire_ignores_the_global_pause(make_wf, fake_agent_manager):
    """Run Now is an explicit user action: "pause all schedules" must not block it."""
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    storage.set_paused(True)

    run = p_run(executor.execute(wf, triggered_by="manual"))
    assert run.status == "success"
    assert fake_agent_manager.sent_messages == ["hi"]


def test_manual_fire_of_a_switched_off_workflow_is_refused(make_wf, fake_agent_manager):
    """Off means off (upstream): a workflow the user toggled off cannot run from ANY path, Run Now included."""
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    stored = storage.get_workflow(wf.id)
    stored.schedule.enabled = False
    storage.save_workflow(stored)

    run = p_run(executor.execute(wf, triggered_by="manual"))
    assert run.status == "skipped"
    assert run.error == "Workflow is paused"
    assert fake_agent_manager.sent_messages == []


def test_global_pause_skip_is_recorded_in_history(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    storage.set_paused(True)

    p_run(executor.execute(wf, triggered_by="schedule"))
    runs = storage.list_runs(wf.id, limit=5)
    assert runs and runs[0].status == "skipped"
    assert runs[0].error == "All schedules are paused"
    assert storage.get_workflow(wf.id).last_run_status == "skipped"


def test_paused_workflow_refusal_is_recorded_in_history(make_wf, fake_agent_manager):
    """A refusal the user cannot see in History reads as the run vanishing (upstream): the paused row lands; a deleted workflow has nothing to attach it to."""
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    stored = storage.get_workflow(wf.id)
    stored.schedule.enabled = False
    storage.save_workflow(stored)

    p_run(executor.execute(wf, triggered_by="schedule"))
    runs = storage.list_runs(wf.id, limit=5)
    assert runs and runs[0].status == "skipped"
    assert runs[0].error == "Workflow is paused"


def test_env_guard_blocks_scheduler_and_stuck_run_reaper(make_wf, fake_agent_manager, monkeypatch):
    from backend.apps.workflows import storage, scheduler
    from backend.apps.workflows.models import WorkflowRun
    wf = make_wf()
    storage.save_workflow(wf)
    stale = WorkflowRun(workflow_id=wf.id, status="running", started_at=datetime.now(), triggered_by="schedule")
    storage.record_run(stale)

    monkeypatch.setenv("OPENSWARM_SCHEDULER_ENABLED", "0")
    p_run(scheduler.start())
    assert scheduler._loop_task is None  # loop never started
    assert storage.list_runs(wf.id, limit=5)[0].status == "running"  # reaper never ran


def test_env_guard_default_on_starts_loop_and_reaps(make_wf, fake_agent_manager, monkeypatch):
    from backend.apps.workflows import storage, scheduler
    from backend.apps.workflows.models import WorkflowRun
    wf = make_wf()
    storage.save_workflow(wf)
    stale = WorkflowRun(workflow_id=wf.id, status="running", started_at=datetime.now(), triggered_by="schedule")
    storage.record_run(stale)
    monkeypatch.delenv("OPENSWARM_SCHEDULER_ENABLED", raising=False)

    async def p_start_then_stop():
        await scheduler.start()
        started = scheduler._loop_task is not None
        await scheduler.stop()
        return started

    assert p_run(p_start_then_stop()) is True
    assert storage.list_runs(wf.id, limit=5)[0].status == "failure"  # reaper marked the stale run
