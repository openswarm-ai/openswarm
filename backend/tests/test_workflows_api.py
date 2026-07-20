"""Route-handler behavior for the trash lifecycle and the global pause switch,
called as coroutines (the established pattern in test_workflows_semantics.py).
CRUD create/patch + If-Match + the calendar endpoint already live in the
semantics suite; this covers the soft-delete -> restore -> purge flow and
pause-all / resume-all, including their 404 guards.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_workflows_api.py -v
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture(autouse=True)
def _wf_env(isolated_workflows_data, reset_scheduler_state, monkeypatch):
    # Silence the ws fan-out the handlers fire; nothing is listening in-test.
    from backend.apps.agents.core.ws_manager import ws_manager

    async def p_noop(*args, **kwargs):
        return None

    monkeypatch.setattr(ws_manager, "broadcast_global", p_noop)
    yield


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_soft_delete_hides_and_disables_schedule(make_wf):
    from backend.apps.workflows import storage
    from backend.apps.workflows.workflows import delete_workflow
    wf = make_wf()
    wf.next_run_at = datetime.now(timezone.utc) + timedelta(hours=1)
    storage.save_workflow(wf)

    res = _run(delete_workflow(wf.id))
    assert res == {"ok": True}
    after = storage.get_workflow(wf.id)
    assert after.deleted_at is not None
    assert after.schedule.enabled is False
    assert after.next_run_at is None
    assert wf.id not in {w.id for w in storage.list_workflows()}
    assert wf.id in {w.id for w in storage.list_deleted_workflows()}


def test_soft_delete_drops_pending_missed(make_wf):
    from backend.apps.workflows import storage
    from backend.apps.workflows.workflows import delete_workflow
    from backend.apps.workflows.models import MissedRun
    wf = make_wf()
    storage.save_workflow(wf)
    storage.add_missed(MissedRun(workflow_id=wf.id, scheduled_for=datetime.now(timezone.utc)))
    _run(delete_workflow(wf.id))
    assert storage.list_missed() == []


def test_restore_brings_back_with_schedule_still_off(make_wf):
    from backend.apps.workflows import storage
    from backend.apps.workflows.workflows import delete_workflow, restore_workflow
    wf = make_wf()
    storage.save_workflow(wf)
    _run(delete_workflow(wf.id))
    enriched = _run(restore_workflow(wf.id))
    assert enriched["id"] == wf.id
    after = storage.get_workflow(wf.id)
    assert after.deleted_at is None
    assert after.schedule.enabled is False  # restore is deliberate; user re-arms
    assert wf.id in {w.id for w in storage.list_workflows()}


def test_purge_only_from_trash_and_removes_record(make_wf):
    from backend.apps.workflows import storage
    from backend.apps.workflows.workflows import delete_workflow, purge_workflow
    wf = make_wf()
    storage.save_workflow(wf)
    _run(delete_workflow(wf.id))
    res = _run(purge_workflow(wf.id))
    assert res == {"ok": True}
    assert storage.get_workflow(wf.id) is None


def test_delete_restore_purge_guards_404(make_wf):
    from fastapi import HTTPException
    from backend.apps.workflows import storage
    from backend.apps.workflows.workflows import delete_workflow, restore_workflow, purge_workflow
    wf = make_wf()
    storage.save_workflow(wf)

    # restore / purge refuse a workflow that isn't in trash.
    for fn in (restore_workflow, purge_workflow):
        with pytest.raises(HTTPException) as exc:
            _run(fn(wf.id))
        assert exc.value.status_code == 404

    # double-delete is a 404 (already gone).
    _run(delete_workflow(wf.id))
    with pytest.raises(HTTPException) as exc:
        _run(delete_workflow(wf.id))
    assert exc.value.status_code == 404


def test_pause_all_and_resume_all_flip_global_flag(make_wf):
    from backend.apps.workflows import storage
    from backend.apps.workflows.workflows import pause_all_schedules, resume_all_schedules
    assert storage.get_paused() is False
    assert _run(pause_all_schedules()) == {"paused": True}
    assert storage.get_paused() is True
    assert _run(resume_all_schedules()) == {"paused": False}
    assert storage.get_paused() is False


# ---- InvokeWorkflow (agents run a workflow as a tool and wait for the result) ----

def test_invoke_unknown_workflow_404():
    from fastapi import HTTPException
    from backend.apps.workflows.workflows import invoke_workflow
    with pytest.raises(HTTPException) as ei:
        _run(invoke_workflow("nope"))
    assert ei.value.status_code == 404


def test_invoke_requires_the_exposed_opt_in(make_wf):
    # A workflow the user never opted in must refuse: exposure is the whole permission model here.
    from fastapi import HTTPException
    from backend.apps.workflows import storage
    from backend.apps.workflows.workflows import invoke_workflow
    wf = make_wf()
    storage.save_workflow(wf)
    with pytest.raises(HTTPException) as ei:
        _run(invoke_workflow(wf.id))
    assert ei.value.status_code == 403


def test_invoke_waits_and_returns_transcript(make_wf, monkeypatch):
    from backend.apps.workflows import storage, executor
    from backend.apps.workflows.models import WorkflowRun
    from backend.apps.workflows.workflows import invoke_workflow
    wf = make_wf(exposed_as_tool=True)
    storage.save_workflow(wf)

    async def p_fake_execute(w, triggered_by="schedule", scheduled_for=None, tested_signature=None):
        assert triggered_by == "manual"
        return WorkflowRun(workflow_id=w.id, status="success", session_id="sess-invoke-1", cost_usd=0.02)

    monkeypatch.setattr(executor, "execute", p_fake_execute)

    from backend.apps.agents.agent_manager import agent_manager

    class p_FakeMsg:
        role = "assistant"
        content = "invoked step done"
        hidden = False

    class p_FakeSess:
        messages = [p_FakeMsg()]

    monkeypatch.setitem(agent_manager.sessions, "sess-invoke-1", p_FakeSess())
    res = _run(invoke_workflow(wf.id))
    assert res["status"] == "success"
    assert res["run_id"]
    assert res["timed_out"] is False
    assert "invoked step done" in res["transcript"]
