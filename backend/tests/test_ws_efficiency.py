"""WS efficiency batch: agent:status frames are slimmed (metadata + previews, never the
transcript), GET /sessions returns the WS seq cursor for resume seeding, and /history's
closed_only filter keeps open sessions out of the client's resurrection gate. Each pins a
live-proven failure mode: full transcripts on status frames were replayed stale and rolled
clients backwards, and an open session in the history map had its terminal frame swallowed."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from backend.apps.agents.core.ws_manager import ws_manager, slim_status_data
from backend.apps.agents.core.seq_log import seq_log
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession, Message
from backend.main import app


def p_client() -> TestClient:
    import backend.auth as auth_mod
    if not auth_mod.TOKEN:
        import secrets
        auth_mod.TOKEN = secrets.token_urlsafe(32)
    return TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"})


def p_status_data(n_msgs: int = 3) -> dict:
    session = {
        "id": "s1",
        "status": "completed",
        "messages": (
            [{"role": "user", "content": "first user question here"}]
            + [{"role": "assistant", "content": f"reply {i} " + "x" * 200} for i in range(n_msgs - 1)]
        ),
        "name": "t",
    }
    return {"session_id": "s1", "status": "completed", "session": session}


def test_slim_drops_transcript_and_adds_previews():
    out = slim_status_data("agent:status", p_status_data(3))
    sess = out["session"]
    assert sess["messages"] == []
    assert sess["message_count"] == 3
    assert sess["first_user_message"].startswith("first user question")
    assert sess["last_message_preview"].startswith("reply 1")
    assert len(sess["last_message_preview"]) <= 120
    # Original input is not mutated (callers may reuse their dicts).
    assert p_status_data(3)["session"]["messages"] != []


def test_slim_leaves_non_status_and_messageless_frames_alone():
    msg_data = {"session_id": "s1", "message": {"role": "user", "content": "hello"}}
    assert slim_status_data("agent:message", msg_data) is msg_data
    no_sess = {"session_id": "s1", "status": "running"}
    assert slim_status_data("agent:status", no_sess) is no_sess


class p_FakeWs:
    def __init__(self) -> None:
        self.frames: list = []

    async def send_text(self, s: str) -> None:
        import json
        self.frames.append(json.loads(s))


def test_send_to_session_slims_status_for_both_socket_kinds_and_the_replay_buffer():
    sess_ws, dash_ws = p_FakeWs(), p_FakeWs()
    sid = "slimtest-session"
    ws_manager.connections[sid] = [sess_ws]
    ws_manager.global_connections.append(dash_ws)
    try:
        asyncio.run(ws_manager.send_to_session(sid, "agent:status", p_status_data(4)))
        asyncio.run(ws_manager.send_to_session(sid, "agent:message", {
            "session_id": sid, "message": {"role": "assistant", "content": "full text stays"},
        }))
        for ws in (sess_ws, dash_ws):
            status = ws.frames[0]
            assert status["data"]["session"]["messages"] == []
            assert status["data"]["session"]["message_count"] == 4
            msg = ws.frames[1]
            assert msg["data"]["message"]["content"] == "full text stays"
        # Both sockets got the SAME stamped seq (the frontend dedupes on it).
        assert sess_ws.frames[0]["seq"] == dash_ws.frames[0]["seq"]
        # The ring buffer stores the slim frame, so replays are slim too.
        _, _, events = seq_log.replay(sid, 0)
        import json
        assert json.loads(events[0])["data"]["session"]["messages"] == []
    finally:
        ws_manager.connections.pop(sid, None)
        ws_manager.global_connections.remove(dash_ws)
        seq_log.clear(sid)


def test_get_session_returns_event_seq_cursor():
    s = AgentSession(name="t", model="sonnet")
    s.messages = [Message(role="user", content="hi")]
    agent_manager.sessions[s.id] = s
    try:
        asyncio.run(ws_manager.send_to_session(s.id, "agent:status", {"session_id": s.id, "status": "running"}))
        asyncio.run(ws_manager.send_to_session(s.id, "agent:status", {"session_id": s.id, "status": "completed"}))
        res = p_client().get(f"/api/agents/sessions/{s.id}")
        assert res.status_code == 200
        body = res.json()
        assert body["event_seq"] == seq_log.current_seq(s.id) == 2
        assert body["messages"][0]["content"] == "hi"
    finally:
        agent_manager.sessions.pop(s.id, None)
        seq_log.clear(s.id)


def test_replay_caught_up_client_gets_nothing_not_the_terminal_frame():
    sid = "caughtup-session"
    ws = p_FakeWs()
    try:
        asyncio.run(ws_manager.send_to_session(sid, "agent:status", {"session_id": sid, "status": "running"}))
        asyncio.run(ws_manager.send_to_session(sid, "agent:status", {"session_id": sid, "status": "completed"}))
        top = seq_log.current_seq(sid)
        ack = asyncio.run(ws_manager.replay_to(sid, ws, top))
        assert ack == {"ok": True, "replayed": 0, "current_seq": top}
        assert ws.frames == []
        # A behind client still gets the real replay.
        ack2 = asyncio.run(ws_manager.replay_to(sid, ws, top - 1))
        assert ack2["replayed"] == 1
    finally:
        seq_log.clear(sid)


def test_history_closed_only_filters_open_sessions(monkeypatch):
    rows = [
        ("open1", {"id": "open1", "name": "open chat", "closed_at": None, "dashboard_id": None}),
        ("closed1", {"id": "closed1", "name": "closed chat", "closed_at": "2026-07-01T00:00:00", "dashboard_id": None}),
    ]
    import backend.apps.agents.manager.session.SessionLifecycle as lifecycle_mod
    monkeypatch.setattr(lifecycle_mod, "load_all_session_data", lambda: list(rows))
    closed = agent_manager.get_history(closed_only=True)
    assert [s["id"] for s in closed["sessions"]] == ["closed1"]
    # Search keeps the full pool: open sessions on other dashboards are reachable nowhere else.
    everything = agent_manager.get_history()
    assert {s["id"] for s in everything["sessions"]} == {"open1", "closed1"}


def test_history_route_threads_closed_only(monkeypatch):
    seen = {}

    def p_spy(**kwargs):
        seen.update(kwargs)
        return {"sessions": [], "total": 0, "has_more": False}

    monkeypatch.setattr(agent_manager, "get_history", p_spy)
    assert p_client().get("/api/agents/history?closed_only=1").status_code == 200
    assert seen["closed_only"] is True
    assert p_client().get("/api/agents/history").status_code == 200
    assert seen["closed_only"] is False
