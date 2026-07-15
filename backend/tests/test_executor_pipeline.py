"""Executor pipeline integration: drive executor.execute() end to end with a
faked agent_manager (the fake_agent_manager fixture) and real on-disk storage.

The existing semantics suite covers the cost-cap skip, p_ran_late in isolation,
and the _persist_run_fields merge/delete races. This fills the gap those leave:
the full run lifecycle through a scripted agent, the terminal-status matrix,
runs_count accounting, step ordering, and the _running lock release on a persist
failure (the crash-hardening fix).

Run:
    cd backend && .venv/bin/python -m pytest tests/test_executor_pipeline.py -v
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest


@pytest.fixture(autouse=True)
def _wf_env(isolated_workflows_data, reset_scheduler_state):
    yield


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# --- terminal-status matrix --------------------------------------------------

def test_successful_run_records_success(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    run = _run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "success"
    assert run.finished_at is not None
    stored = storage.list_runs(wf.id, limit=10)
    assert stored[0].status == "success"
    assert storage.get_workflow(wf.id).last_run_status == "success"


def test_agent_error_marks_failure(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    fake_agent_manager.statuses = ["error"]
    wf = make_wf()
    storage.save_workflow(wf)
    run = _run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "failure"
    assert run.error == "Agent session entered error state"


def test_scheduled_run_late_start_marks_ran_late(make_wf, fake_agent_manager):
    """A scheduled fire whose slot is already >5min in the past when it starts
    is classified ran_late, not success, even though the agent succeeds."""
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    slot = datetime.now(timezone.utc) - timedelta(minutes=10)
    run = _run(executor.execute(wf, triggered_by="schedule", scheduled_for=slot))
    assert run.status == "ran_late"
    assert storage.get_workflow(wf.id).last_run_status == "ran_late"


def test_overlap_skipped_when_already_running(make_wf, fake_agent_manager):
    """A second fire while a run for the same workflow holds _running is skipped
    with a clear reason, never launching a second agent."""
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    executor._running[wf.id] = "in-flight-run"
    run = _run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "skipped"
    assert run.error == "Previous run still active"
    assert fake_agent_manager.launched_configs == []


# --- runs_count accounting ---------------------------------------------------

def test_schedule_run_bumps_runs_count(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    _run(executor.execute(wf, triggered_by="schedule"))
    assert storage.get_workflow(wf.id).schedule.runs_count == 1


def test_manual_run_does_not_bump_runs_count(make_wf, fake_agent_manager):
    """Manual runs are free presses of the Run button; they must not count
    against max_runs."""
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)
    _run(executor.execute(wf, triggered_by="manual"))
    assert storage.get_workflow(wf.id).schedule.runs_count == 0


# --- step iteration ----------------------------------------------------------

def test_steps_sent_in_order(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    from backend.apps.workflows.models import WorkflowStep
    wf = make_wf(steps=[WorkflowStep(text="one"), WorkflowStep(text="two"), WorkflowStep(text="three")])
    storage.save_workflow(wf)
    _run(executor.execute(wf, triggered_by="schedule"))
    assert fake_agent_manager.sent_messages == ["one", "two", "three"]


def test_disabled_and_blank_steps_are_skipped(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    from backend.apps.workflows.models import WorkflowStep
    wf = make_wf(steps=[
        WorkflowStep(text="run me"),
        WorkflowStep(text="muted", enabled=False),
        WorkflowStep(text="   "),
        WorkflowStep(text="me too"),
    ])
    storage.save_workflow(wf)
    _run(executor.execute(wf, triggered_by="schedule"))
    assert fake_agent_manager.sent_messages == ["run me", "me too"]


def test_mid_sequence_error_halts_remaining_steps(make_wf, fake_agent_manager):
    """An error on step 2 stops the run; step 3 is never dispatched."""
    from backend.apps.workflows import storage, executor
    from backend.apps.workflows.models import WorkflowStep
    fake_agent_manager.statuses = ["completed", "error"]
    wf = make_wf(steps=[WorkflowStep(text="s1"), WorkflowStep(text="s2"), WorkflowStep(text="s3")])
    storage.save_workflow(wf)
    run = _run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "failure"
    assert fake_agent_manager.sent_messages == ["s1", "s2"]


def test_no_runnable_steps_fails(make_wf, fake_agent_manager):
    from backend.apps.workflows import storage, executor
    from backend.apps.workflows.models import WorkflowStep
    wf = make_wf(steps=[WorkflowStep(text="", enabled=True)])
    storage.save_workflow(wf)
    run = _run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "failure"
    assert "no steps" in (run.error or "").lower()
    assert fake_agent_manager.launched_configs == []


# --- crash hardening: the lock must always be released -----------------------

def test_running_lock_released_on_persist_failure(make_wf, fake_agent_manager, monkeypatch):
    """If persisting run fields throws after _running is claimed, the finally
    must still release the lock; otherwise the workflow is wedged 'running'
    forever and every future fire is skipped. Guards the fix that moved the
    running-persist inside the try whose finally frees _running."""
    from backend.apps.workflows import storage, executor
    wf = make_wf()
    storage.save_workflow(wf)

    def p_boom(*args, **kwargs):
        raise RuntimeError("disk gone")

    monkeypatch.setattr(executor, "_persist_run_fields", p_boom)
    with pytest.raises(RuntimeError):
        _run(executor.execute(wf, triggered_by="schedule"))
    assert wf.id not in executor._running


def test_resolved_config_uses_workflow_model_and_tools(make_wf, fake_agent_manager):
    """The launched AgentConfig reflects the workflow's model and, when frozen,
    its configured tool set rather than the default surface."""
    from backend.apps.workflows import storage, executor
    from backend.apps.workflows.models import ActionsConfig
    wf = make_wf(model="opus", actions=ActionsConfig(freeze=True, configured_sets=["Read", "Grep"]))
    storage.save_workflow(wf)
    _run(executor.execute(wf, triggered_by="schedule"))
    config = fake_agent_manager.launched_configs[0]
    assert config.model == "opus"
    assert config.allowed_tools == ["Read", "Grep"]


# --- idle-based step timeout ---------------------------------------------------

def test_silent_running_session_times_out(fake_agent_manager):
    """A session stuck in 'running' with no message or stream activity must
    still die after idle_timeout_s, keeping the hung-step protection."""
    from backend.apps.workflows import executor
    fake_agent_manager.sessions["s1"] = SimpleNamespace(id="s1", status="running", messages=[])
    with pytest.raises(TimeoutError, match="No agent activity"):
        _run(executor._await_session_idle("s1", idle_timeout_s=0.3))


def test_message_activity_defers_idle_timeout(fake_agent_manager):
    """A busy step outliving idle_timeout_s must NOT be killed as long as new
    messages keep landing; the deadline is idle-based, not a wall-clock cap."""
    from backend.apps.workflows import executor
    sess = SimpleNamespace(id="s1", status="running", messages=[])
    fake_agent_manager.sessions["s1"] = sess

    async def p_drive():
        async def p_appender():
            # 10 ticks x 0.1s = 1.0s of activity, >3x the 0.3s idle window.
            for i in range(10):
                await asyncio.sleep(0.1)
                sess.messages.append(SimpleNamespace(id=f"m{i}", timestamp=datetime.now()))
            sess.status = "completed"
        task = asyncio.ensure_future(p_appender())
        try:
            return await executor._await_session_idle("s1", idle_timeout_s=0.3)
        finally:
            task.cancel()

    assert _run(p_drive()) == "idle"


def test_stream_partial_activity_defers_idle_timeout(fake_agent_manager):
    """Mid-stream text growth (live_partial) counts as activity even when no
    message has committed yet, so a long single response doesn't trip it."""
    from backend.apps.workflows import executor
    sess = SimpleNamespace(id="s1", status="running", messages=[])
    fake_agent_manager.sessions["s1"] = sess

    async def p_drive():
        async def p_streamer():
            text = ""
            for _ in range(10):
                await asyncio.sleep(0.1)
                text += "chunk "
                fake_agent_manager.live_partial["s1"] = SimpleNamespace(text=text)
            sess.status = "completed"
        task = asyncio.ensure_future(p_streamer())
        try:
            return await executor._await_session_idle("s1", idle_timeout_s=0.3)
        finally:
            task.cancel()

    assert _run(p_drive()) == "idle"
