"""ENG-335: the builder agent can save a workflow with ZERO steps after visibly doing the work
("Ran 3 steps", saved none), turning every scheduled run into "Workflow has no steps". Prompt
rules didn't hold, so the seal is mechanical at the run gate: promote an uncommitted draft, else
synthesize one step from the build chat's first user message. These pin all three ladder rungs."""

from backend.apps.workflows import executor, storage
from backend.apps.workflows.models import Workflow, WorkflowStep


def p_wf(**kw) -> Workflow:
    wf = Workflow(title="T", description="", system_prompt="", steps=[], **kw)
    return wf


def test_pending_draft_is_promoted(monkeypatch, tmp_path):
    saved = {}
    monkeypatch.setattr(storage, "save_workflow", lambda w: saved.setdefault("wf", w))
    wf = p_wf()
    wf.draft_steps = [WorkflowStep(id="d1", text="check example.com", label="Check", enabled=True)]
    assert executor.rescue_missing_steps(wf) is True
    assert [s.text for s in wf.steps] == ["check example.com"]
    assert wf.draft_steps is None, "activating the workflow IS the commit"
    assert saved["wf"] is wf


def test_step_synthesized_from_build_chat_first_message(monkeypatch):
    monkeypatch.setattr(storage, "save_workflow", lambda w: None)
    from backend.apps.agents.manager.session import session_store
    monkeypatch.setattr(session_store, "load_session_data", lambda sid: {
        "messages": [
            {"role": "assistant", "content": "hello"},
            {"role": "user", "hidden": True, "content": "[Automated message] continue"},
            {"role": "user", "content": "plan my lunch near 501 folsom st"},
        ],
    })
    wf = p_wf()
    wf.edit_agent_session_id = "sess-1"
    assert executor.rescue_missing_steps(wf) is True
    assert wf.steps[0].text == "plan my lunch near 501 folsom st"
    assert wf.steps[0].enabled is True


def test_nothing_to_rescue_keeps_the_honest_error(monkeypatch):
    monkeypatch.setattr(storage, "save_workflow", lambda w: None)
    wf = p_wf()
    assert executor.rescue_missing_steps(wf) is False
    assert wf.steps == []
