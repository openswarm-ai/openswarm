"""The /compact endpoint must actually trigger a rebuild, not just mark.

The bug: two handlers registered POST .../compact; the live one (agents.py) only set
the compaction marker, so /compact never dropped the SDK session and the trim (and the
distilled summary) was never applied, the button silently did nothing visible. After
consolidating to one handler, /compact sets needs_fresh_session so the next turn rebuilds.
This pins that wiring against the real route.
"""

from fastapi.testclient import TestClient

from backend.main import app
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession, Message


def p_client() -> TestClient:
    import backend.auth as auth_mod
    if not auth_mod.TOKEN:
        import secrets
        auth_mod.TOKEN = secrets.token_urlsafe(32)
    return TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"})


def p_seed(n: int) -> AgentSession:
    s = AgentSession(name="t", model="sonnet")
    s.context_window = 100
    s.tokens = {"input": 90, "output": 0}  # 0.90 -> over threshold
    s.messages = [Message(role="user", content=f"m{i}") for i in range(n)]
    s.sdk_session_id = "sdk-live-123"
    agent_manager.sessions[s.id] = s
    return s


def test_compact_sets_needs_fresh_session_so_it_rebuilds() -> None:
    s = p_seed(10)
    try:
        r = p_client().post(f"/api/agents/sessions/{s.id}/compact")
        assert r.status_code == 200
        assert r.json()["compacted"] is True
        assert s.compacted_through_msg_id is not None
        # The whole point: the button opts into the rebuild, so the next turn drops the SDK convo and applies the cutoff/distill.
        assert s.needs_fresh_session is True
    finally:
        agent_manager.sessions.pop(s.id, None)


def test_compact_noop_when_nothing_to_trim_leaves_state_clean() -> None:
    s = p_seed(3)  # too few messages to compact
    try:
        r = p_client().post(f"/api/agents/sessions/{s.id}/compact")
        assert r.status_code == 200
        assert r.json()["compacted"] is False
        assert s.needs_fresh_session is False
    finally:
        agent_manager.sessions.pop(s.id, None)


def test_compact_unknown_session_404() -> None:
    r = p_client().post("/api/agents/sessions/no-such-session/compact")
    assert r.status_code == 404
