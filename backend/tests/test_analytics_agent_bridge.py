import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.service.analytics import agent_bridge


def p_session_module(session_id: str, session: AgentSession) -> ModuleType:
    module = ModuleType("backend.apps.agents.agent_manager")
    module.agent_manager = SimpleNamespace(sessions={session_id: session})
    return module


def test_thinking_telemetry_only_tracks_final_snapshot(monkeypatch):
    session_id = "session-1"
    thought = Message(id="thought-1", role="thinking", content="final")
    session = AgentSession(name="test", messages=[thought])
    track = Mock()
    monkeypatch.setitem(sys.modules, "backend.apps.agents.agent_manager", p_session_module(session_id, session))
    monkeypatch.setattr(agent_bridge, "track_agent_message", track)
    broadcast = agent_bridge.BroadcastMessage.model_validate(thought.model_dump(mode="json"))

    agent_bridge.bridge_agent_message(session_id, broadcast)
    track.assert_not_called()

    agent_bridge.bridge_agent_message(session_id, broadcast, final=True)
    track.assert_called_once()
    assert track.call_args.kwargs["id"] == "thought-1"
    assert track.call_args.kwargs["content"] == "final"


def test_non_thinking_message_tracks_without_final_marker(monkeypatch):
    session_id = "session-1"
    message = Message(id="user-1", role="user", content="hello")
    session = AgentSession(name="test", messages=[message])
    track = Mock()
    monkeypatch.setitem(sys.modules, "backend.apps.agents.agent_manager", p_session_module(session_id, session))
    monkeypatch.setattr(agent_bridge, "track_agent_message", track)

    agent_bridge.bridge_agent_message(
        session_id,
        agent_bridge.BroadcastMessage.model_validate(message.model_dump(mode="json")),
    )

    track.assert_called_once()
    assert track.call_args.kwargs["role"] == "user"
