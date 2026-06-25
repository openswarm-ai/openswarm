"""Shared test fixtures.

Isolate the persistent browser-skill store (and metrics) into throwaway temp
dirs for the whole test session, so tests never write skills/metrics into the
real ~/Library/Application Support/OpenSwarm/data tree (which would pollute the
dev machine and let a stale persisted skill leak across test runs).

The workflow fixtures below (isolated_workflows_data, reset_scheduler_state,
make_wf, fake_agent_manager) are deliberately NOT autouse: only the scheduled-
workflows suites opt in, so they never touch unrelated browser/service tests.
The two pre-existing workflow suites still carry their own local copies; new
suites lean on these shared ones instead of re-pasting the boilerplate.
"""

import asyncio
import os
import tempfile
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest


@pytest.fixture(autouse=True)
def _isolate_browser_state(monkeypatch):
    skills_dir = tempfile.mkdtemp(prefix="os_skills_")
    metrics_dir = tempfile.mkdtemp(prefix="os_metrics_")
    playbook_dir = tempfile.mkdtemp(prefix="os_playbook_")
    monkeypatch.setenv("OPENSWARM_BROWSER_SKILLS_DIR", skills_dir)
    monkeypatch.setenv("OPENSWARM_BROWSER_METRICS_DIR", metrics_dir)
    monkeypatch.setenv("OPENSWARM_BROWSER_PLAYBOOK_DIR", playbook_dir)

    def _reset():
        for mod in ("browser_skills", "browser_playbook"):
            try:
                m = __import__(f"backend.apps.agents.browser.{mod}", fromlist=[mod])
                m.clear(wipe_disk=True)
            except Exception:
                pass
        # metrics caches its dir at first use; drop it so each test writes where ITS env var points, not where the first test's pointed
        try:
            from backend.apps.agents.browser import browser_metrics as _bm
            _bm.p_metrics_dir_cache = None
        except Exception:
            pass
    _reset()
    yield
    _reset()


@pytest.fixture
def isolated_workflows_data(monkeypatch, tmp_path):
    """Point the workflow store at a throwaway tmpdir and start every test with
    empty in-memory caches, so nothing leaks into a real install or across
    tests. Mirrors the local fixtures in test_workflows_semantics.py and
    test_schedule_e2e.py; opt in by requesting this fixture (or depend on it
    from a file-local autouse)."""
    from backend.apps.workflows import storage as p_storage
    from backend.apps.workflows import audit as p_audit
    from backend.apps.workflows import escalation as p_escalation
    monkeypatch.setattr(p_storage, "DATA_DIR", str(tmp_path / "workflows"))
    monkeypatch.setattr(p_storage, "RUNS_DIR", str(tmp_path / "workflows" / "runs"))
    monkeypatch.setattr(p_storage, "PAUSED_FILE", str(tmp_path / "workflows" / "paused.json"))
    monkeypatch.setattr(p_storage, "MISSED_FILE", str(tmp_path / "workflows" / "missed.json"))
    monkeypatch.setattr(p_storage, "_workflow_cache", {})
    monkeypatch.setattr(p_storage, "_runs_cache", {})
    monkeypatch.setattr(p_storage, "_missed_cache", [])
    monkeypatch.setattr(p_storage, "_cache_loaded", False)
    monkeypatch.setattr(p_storage, "_paused", False)
    monkeypatch.setattr(p_audit, "AUDIT_DIR", str(tmp_path / "workflows" / "audit"))
    p_escalation._tasks.clear()
    p_escalation._state.clear()
    yield


@pytest.fixture
def reset_scheduler_state(monkeypatch):
    """Reset the scheduler + executor module globals that otherwise survive
    across tests and cause order-dependent flakes: a stale _wake Event bound to
    a dead loop, a lingering _loop_task, a cached host tz, or a leftover entry
    in the _running / control maps."""
    from backend.apps.workflows import scheduler as p_scheduler
    from backend.apps.workflows import executor as p_executor
    p_scheduler._loop_task = None
    p_scheduler._wake = asyncio.Event()
    monkeypatch.setattr(p_scheduler, "_host_tz_cache", None)
    p_executor._running.clear()
    p_executor._run_control.clear()
    p_executor._run_pause_override.clear()
    yield
    p_executor._running.clear()
    p_executor._run_control.clear()
    p_executor._run_pause_override.clear()


@pytest.fixture
def make_wf():
    """Factory for a Workflow with a sane default daily-9am-LA schedule;
    override any field via kwargs."""
    def p_build(**overrides):
        from backend.apps.workflows.models import Workflow, ScheduleConfig, WorkflowStep
        base = dict(
            title="t",
            steps=[WorkflowStep(text="hi")],
            schedule=ScheduleConfig(
                enabled=True, repeat_unit="day", repeat_every=1,
                hour=9, minute=0, timezone="America/Los_Angeles",
            ),
        )
        base.update(overrides)
        return Workflow(**base)
    return p_build


class FakeAgentManager:
    """Stand-in for agent_manager so executor.execute() drives a full run
    without a live LLM. Records launched configs + every step prompt sent, and
    lets a test script the per-step terminal status (the value
    _await_session_idle reads): default 'completed' (-> advance), or 'error' /
    'stopped' to exercise the failure paths.
    """

    def __init__(self):
        self.sessions: dict[str, SimpleNamespace] = {}
        self.tasks: dict[str, object] = {}
        self.launched_configs: list[object] = []
        self.sent_messages: list[str] = []
        # statuses[i] is the session status after the i-th send_message; absent entries default to 'completed'. cost_usd lands on the run.
        self.statuses: list[str] = []
        self.cost_usd: float = 0.0

    async def launch_agent(self, config):
        self.launched_configs.append(config)
        sid = f"sess-{len(self.sessions)}"
        sess = SimpleNamespace(id=sid, status="completed", cost_usd=self.cost_usd, messages=[])
        self.sessions[sid] = sess
        return sess

    async def send_message(self, session_id, text, hidden=False):
        i = len(self.sent_messages)
        self.sent_messages.append(text)
        sess = self.sessions.get(session_id)
        if sess is not None:
            sess.status = self.statuses[i] if i < len(self.statuses) else "completed"

    async def close_session(self, session_id):
        self.sessions.pop(session_id, None)


@pytest.fixture
def fake_agent_manager(monkeypatch):
    """Patch the agent_manager seam (plus the ws + notifier side effects) that
    executor.execute imports lazily, and hand back the FakeAgentManager so the
    test can script statuses and assert on launched configs / sent steps."""
    from backend.apps.agents import agent_manager as p_am
    from backend.apps.agents.core.ws_manager import ws_manager as p_ws
    from backend.apps.workflows import notifier as p_notifier

    fake = FakeAgentManager()
    monkeypatch.setattr(p_am.agent_manager, "sessions", fake.sessions)
    monkeypatch.setattr(p_am.agent_manager, "tasks", fake.tasks)
    monkeypatch.setattr(p_am.agent_manager, "launch_agent", fake.launch_agent)
    monkeypatch.setattr(p_am.agent_manager, "send_message", fake.send_message)
    monkeypatch.setattr(p_am.agent_manager, "close_session", fake.close_session)

    async def p_noop_async(*args, **kwargs):
        return None

    from backend.apps.agents.manager.permissions import workflow_approval as p_wa
    monkeypatch.setattr(p_wa, "set_workflow_approval_memory", lambda *a, **k: None)
    monkeypatch.setattr(p_wa, "set_workflow_approval_step", lambda *a, **k: None)
    monkeypatch.setattr(p_wa, "clear_workflow_approval_memory", lambda *a, **k: None)
    monkeypatch.setattr(p_wa, "get_workflow_step_usage", lambda *a, **k: {})
    monkeypatch.setattr(p_ws, "broadcast_global", p_noop_async)
    monkeypatch.setattr(p_notifier, "notify_run_complete", p_noop_async)
    return fake
