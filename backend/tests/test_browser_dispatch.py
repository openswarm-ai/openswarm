"""Drives the moved browser fast-path dispatch (manager/run_browser_fast_path.py) end to end
with a real AgentSession + a mocked browser sub-agent. This path was never directly
tested before it was lifted out of agent_manager, so this pins its actual behavior."""

import asyncio

import backend.apps.agents.manager.run_browser_fast_path as bd
import backend.apps.agents.browser.browser_agent as browser_agent_mod
from backend.apps.agents.core.models import AgentSession


def p_patch_io(monkeypatch, dispatch_result, *, has_dashboard=True):
    sent = []
    saved = []

    async def fake_send(session_id, event, data):
        sent.append((event, data))

    def fake_save(session_id, doc):
        saved.append(session_id)

    async def fake_run(**kwargs):
        fake_run.calls.append(kwargs)
        return [dispatch_result]
    fake_run.calls = []

    monkeypatch.setattr(bd.ws_manager, "send_to_session", fake_send, raising=True)
    monkeypatch.setattr(bd.ws_manager, "global_connections", [object()] if has_dashboard else [], raising=False)
    monkeypatch.setattr(bd, "save_session", fake_save, raising=True)
    monkeypatch.setattr(browser_agent_mod, "run_browser_agents", fake_run, raising=True)
    return sent, saved, fake_run


def test_fast_path_success_replies_with_the_browser_summary(monkeypatch):
    sent, saved, fake_run = p_patch_io(
        monkeypatch, {"summary": "Booked the flight to NYC", "done": True, "action_log": []}
    )
    session = AgentSession(name="t", model="sonnet", dashboard_id="dash-1")
    asyncio.run(bd.run_browser_fast_path(
        session, session.id, "book me a flight to NYC", ["browser-1"], brief="", verdict="act",
    ))

    roles = [m.role for m in session.messages]
    assert "tool_call" in roles and "tool_result" in roles  # synthetic Browser Agent bubble
    assert any(m.role == "assistant" and m.content == "Booked the flight to NYC" for m in session.messages)
    assert session.status == "completed"
    assert session.closed_at is not None
    assert saved  # session snapshot persisted
    assert any(e == "agent:message" for e, _ in sent)
    assert any(e == "agent:status" for e, _ in sent)
    # dispatched to the selected browser, parented to this session
    assert fake_run.calls and fake_run.calls[0]["pre_selected_browser_ids"] == ["browser-1"]
    assert fake_run.calls[0]["parent_session_id"] == session.id


def test_fast_path_no_dashboard_returns_friendly_reply(monkeypatch):
    p_patch_io(
        monkeypatch, {"summary": "", "done": False, "action_log": []}, has_dashboard=False,
    )
    session = AgentSession(name="t", model="sonnet", dashboard_id="dash-1")
    asyncio.run(bd.run_browser_fast_path(
        session, session.id, "go to example.com", ["browser-1"], brief="", verdict="act",
    ))

    assert any(
        m.role == "assistant" and "no OpenSwarm window is connected" in str(m.content)
        for m in session.messages
    )
    assert session.status == "completed"
