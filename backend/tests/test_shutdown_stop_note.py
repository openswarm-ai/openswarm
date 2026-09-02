"""A chat that was running when the backend shut down must say so, or the flush reads as the user's Stop.

2026-09-01: an agent's `pkill -f uvicorn` SIGTERMed Eric's production backend twice; every running chat
was persisted as plain "stopped" and nothing in the transcript said why (row 1, silent work loss)."""
import asyncio
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.session import SessionPersistence as sp


def p_session(status: str) -> AgentSession:
    s = AgentSession(name="t", model="sonnet", status=status)
    s.messages.append(Message(role="user", content="build the thing", branch_id="main"))
    return s


def test_a_running_chat_gets_the_shutdown_note_and_stops(monkeypatch, tmp_path) -> None:
    saved: dict = {}
    monkeypatch.setattr(sp, "save_session", lambda sid, doc: saved.__setitem__(sid, doc))
    s = p_session("running")
    agent_manager.sessions.clear(); agent_manager.sessions[s.id] = s
    asyncio.run(agent_manager.persist_all_sessions())
    doc = saved[s.id]
    assert doc["status"] == "stopped"
    last = doc["messages"][-1]
    assert last["role"] == "system", "the note is the platform speaking, never the model"
    assert "not your Stop" in last["content"] and "Send a message to continue" in last["content"]


def test_a_settled_chat_is_flushed_untouched(monkeypatch) -> None:
    saved: dict = {}
    monkeypatch.setattr(sp, "save_session", lambda sid, doc: saved.__setitem__(sid, doc))
    s = p_session("completed")
    agent_manager.sessions.clear(); agent_manager.sessions[s.id] = s
    asyncio.run(agent_manager.persist_all_sessions())
    doc = saved[s.id]
    assert doc["status"] == "completed"
    assert doc["messages"][-1]["role"] == "user", "no note on a chat that was not running"


def test_the_lifespan_stamps_live_turns_before_it_stops_them(monkeypatch) -> None:
    """Placement, not just behaviour: stop_agent flips running -> stopped, so a note keyed on
    "running" at flush time never fires for a chat that was a task (dev kill matrix A9a)."""
    import inspect
    from backend.apps.agents import agents as agents_mod
    src = inspect.getsource(agents_mod.agents_lifespan)
    assert src.index("note_shutdown_stops()") < src.index("stop_agent(session_id)")
    s = p_session("running")
    agent_manager.sessions.clear(); agent_manager.sessions[s.id] = s
    monkeypatch.setitem(agent_manager.tasks, s.id, object())
    try:
        assert agent_manager.note_shutdown_stops() == 1
    finally:
        agent_manager.tasks.pop(s.id, None)
    assert s.messages[-1].role == "system" and "not your Stop" in str(s.messages[-1].content)
    assert agent_manager.note_shutdown_stops() == 0, "a settled or already-stamped chat is not stamped twice"
