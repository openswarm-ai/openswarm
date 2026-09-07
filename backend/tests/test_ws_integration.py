"""Real-server end-to-end WebSocket test: the closest in-repo proxy to a live desktop run. A WS
client connects to the actual FastAPI app, sends agent:send_message, and the agent loop runs and
streams its events BACK over the real WS transport. This exercises the whole live path the
desktop app uses, FastAPI app + WS route + ws_manager + send_message + run_agent_loop + the
extracted handlers + the broadcast, which the in-process harness (no server, no WS) can't cover.
The SDK and WS auth are mocked; everything else is the real running stack."""

import asyncio

import pytest

import claude_agent_sdk
from claude_agent_sdk import AssistantMessage, ResultMessage
from claude_agent_sdk.types import TextBlock
from fastapi.testclient import TestClient

import backend.main as main_mod
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession


def p_assistant():
    return AssistantMessage(content=[TextBlock(text="hello from the loop")], model="sonnet",
                            message_id="m1", stop_reason="end_turn", session_id="s",
                            usage={"input_tokens": 10, "output_tokens": 5})


def p_result():
    return ResultMessage(subtype="success", duration_ms=10, duration_api_ms=8, is_error=False,
                         num_turns=1, session_id="s", usage={"input_tokens": 10, "output_tokens": 5})


def test_ws_endpoint_streams_a_full_turn_end_to_end(monkeypatch):
    monkeypatch.setattr(main_mod, "p_ws_auth_ok", lambda ws: True, raising=True)

    async def fake_query(*args, **kwargs):
        yield p_assistant()
        yield p_result()

    monkeypatch.setattr(claude_agent_sdk, "query", fake_query, raising=True)
    # The loop is the thing under test, not the router: on a runner with no router the env build refused the turn
    # ("9Router is not running"), the failure never carried the awaited text, and receive_json() waited for a message
    # that would never come until the job timed out (every CI leg, 2026-09-06). The router is faked present.
    from backend.apps.agents.manager import configure_provider_env as cpe

    async def router_present(settings):
        return True

    monkeypatch.setattr(cpe, "router_available", router_present, raising=True)

    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    agent_manager.sessions[session.id] = session
    agent_manager.tasks.pop(session.id, None)

    client = TestClient(main_mod.app)
    try:
        with client.websocket_connect(f"/ws/agents/{session.id}") as ws:
            ws.send_json({"event": "agent:send_message", "data": {"prompt": "hi"}})
            seen = []
            for _ in range(40):
                ev = ws.receive_json()
                seen.append(ev.get("event"))
                if ev.get("event") == "agent:message" and "hello from the loop" in str(ev.get("data", {})):
                    break
                # A turn that ended without the reply is a failure to report, not a message to wait for.
                if ev.get("event") == "agent:status" and str(ev.get("data", {}).get("status")) in ("error", "failed", "completed"):
                    break
        # the real loop's assistant reply made it all the way back over the WS
        assert "agent:message" in seen
        assert any(m.role == "assistant" and "hello from the loop" in str(m.content)
                   for m in session.messages)
    finally:
        agent_manager.sessions.pop(session.id, None)
        agent_manager.tasks.pop(session.id, None)
