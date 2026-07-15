"""A paused or trashed workflow must stop its in-flight run, not run to completion.

The bug: the scheduler stopped FUTURE fires on pause/trash, but an already-running
execution kept stepping (the executor never re-read the workflow's live state), and a
trashed run couldn't even be stopped by hand. These drive executor.execute() end to end
(faked agent) and mutate the workflow mid-run to prove the run halts at the next step.
"""

from __future__ import annotations

import asyncio
from datetime import datetime

import pytest

from backend.apps.workflows.models import WorkflowStep


@pytest.fixture(autouse=True)
def p_wf_env(isolated_workflows_data, reset_scheduler_state):
    yield


def p_run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def p_three_step_wf(make_wf):
    return make_wf(steps=[WorkflowStep(text="step1"), WorkflowStep(text="step2"), WorkflowStep(text="step3")])


def p_mutate_after_first_step(monkeypatch, fake_agent_manager, mutate):
    """Wrap the faked send_message so `mutate()` runs right after step1 is sent."""
    from backend.apps.agents import agent_manager as p_am
    orig = p_am.agent_manager.send_message

    async def wrapped(session_id, text, hidden=False):
        await orig(session_id, text, hidden=hidden)
        if text == "step1":
            mutate()

    monkeypatch.setattr(p_am.agent_manager, "send_message", wrapped)


def test_trashed_scheduled_run_halts_at_next_step(make_wf, fake_agent_manager, monkeypatch):
    from backend.apps.workflows import storage, executor
    wf = p_three_step_wf(make_wf)
    storage.save_workflow(wf)

    def trash():
        w = storage.get_workflow(wf.id)
        w.deleted_at = datetime.now()
        storage.save_workflow(w)

    p_mutate_after_first_step(monkeypatch, fake_agent_manager, trash)
    run = p_run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "failure"
    assert run.error == "Workflow deleted"
    assert fake_agent_manager.sent_messages == ["step1"]  # step2/step3 never sent


def test_trashed_manual_run_also_halts(make_wf, fake_agent_manager, monkeypatch):
    """A deleted workflow stops for ANY trigger, not just scheduled."""
    from backend.apps.workflows import storage, executor
    wf = p_three_step_wf(make_wf)
    storage.save_workflow(wf)

    def trash():
        w = storage.get_workflow(wf.id)
        w.deleted_at = datetime.now()
        storage.save_workflow(w)

    p_mutate_after_first_step(monkeypatch, fake_agent_manager, trash)
    run = p_run(executor.execute(wf, triggered_by="manual"))
    assert run.error == "Workflow deleted"
    assert fake_agent_manager.sent_messages == ["step1"]


def test_paused_scheduled_run_halts_at_next_step(make_wf, fake_agent_manager, monkeypatch):
    from backend.apps.workflows import storage, executor
    wf = p_three_step_wf(make_wf)
    storage.save_workflow(wf)

    def pause():
        w = storage.get_workflow(wf.id)
        w.schedule.enabled = False
        storage.save_workflow(w)

    p_mutate_after_first_step(monkeypatch, fake_agent_manager, pause)
    run = p_run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "failure"
    assert run.error == "Workflow paused"
    assert fake_agent_manager.sent_messages == ["step1"]


def test_pause_does_not_halt_a_manual_run(make_wf, fake_agent_manager, monkeypatch):
    """Pausing the SCHEDULE must not kill a manual Run Now that's in flight."""
    from backend.apps.workflows import storage, executor
    wf = p_three_step_wf(make_wf)
    storage.save_workflow(wf)

    def pause():
        w = storage.get_workflow(wf.id)
        w.schedule.enabled = False
        storage.save_workflow(w)

    p_mutate_after_first_step(monkeypatch, fake_agent_manager, pause)
    run = p_run(executor.execute(wf, triggered_by="manual"))
    assert run.status == "success"
    assert fake_agent_manager.sent_messages == ["step1", "step2", "step3"]  # all ran


def test_stop_active_run_signals_and_returns_session(make_wf, fake_agent_manager, monkeypatch):
    """delete/pause use executor.stop_active_run to halt a live run even after trash."""
    from backend.apps.workflows import storage, executor
    wf = p_three_step_wf(make_wf)
    storage.save_workflow(wf)
    captured: dict = {}

    def grab_then_trash():
        # While the run is live, stop_active_run must find its session and signal stop.
        captured["session"] = executor.stop_active_run(wf.id)

    p_mutate_after_first_step(monkeypatch, fake_agent_manager, grab_then_trash)
    run = p_run(executor.execute(wf, triggered_by="schedule"))
    assert captured["session"] is not None  # found the live session
    assert run.error == "Stopped by user"  # _run_control stop took effect
    assert fake_agent_manager.sent_messages == ["step1"]


def test_no_running_workflow_returns_none(make_wf, fake_agent_manager):
    from backend.apps.workflows import executor
    assert executor.stop_active_run("no-such-workflow") is None
