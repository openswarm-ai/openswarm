"""Real-server end-to-end WebSocket test: the closest in-repo proxy to a live desktop run. A WS
client connects to the actual FastAPI app, sends agent:send_message, and the agent loop runs and
streams its events BACK over the real WS transport. This exercises the whole live path the
desktop app uses, FastAPI app + WS route + ws_manager + send_message + run_agent_loop + the
extracted handlers + the broadcast, which the in-process harness (no server, no WS) can't cover.
The SDK and WS auth are mocked; everything else is the real running stack."""

import asyncio
import queue
import threading

import pytest

import claude_agent_sdk
from claude_agent_sdk import AssistantMessage, ResultMessage
from claude_agent_sdk.types import TextBlock
from fastapi.testclient import TestClient

import backend.main as main_mod
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession
import backend.apps.agents.manager.run.RunOptions as run_options_mod


def p_receive_json(ws, timeout: float = 5.0):
    """ws.receive_json() blocks forever when the event never comes; a regression in the loop then
    hangs the whole pytest run instead of failing this test. Bound every receive."""
    out = queue.Queue(maxsize=1)

    def p_recv():
        try:
            out.put((True, ws.receive_json()))
        except BaseException as exc:
            out.put((False, exc))

    thread = threading.Thread(target=p_recv, daemon=True)
    thread.start()
    try:
        ok, value = out.get(timeout=timeout)
    except queue.Empty as exc:
        raise AssertionError(f"timed out waiting for websocket event after {timeout}s") from exc
    if ok:
        return value
    raise value


def p_assistant():
    return AssistantMessage(content=[TextBlock(text="hello from the loop")], model="sonnet",
                            message_id="m1", stop_reason="end_turn", session_id="s",
                            usage={"input_tokens": 10, "output_tokens": 5})


def p_result():
    return ResultMessage(subtype="success", duration_ms=10, duration_api_ms=8, is_error=False,
                         num_turns=1, session_id="s", usage={"input_tokens": 10, "output_tokens": 5})


def test_ws_endpoint_streams_a_full_turn_end_to_end(monkeypatch):
    monkeypatch.setattr(main_mod, "p_ws_auth_ok", lambda ws: True, raising=True)

    # The contract of this test is "SDK and WS auth mocked, everything else real", but two things on
    # the turn path reach outside the process and must not decide the outcome: configure_provider_env
    # can wander into 9Router revival (spawn/npm install, serialized on a module-level lock) whenever
    # earlier tests left provider evidence behind, and the background turn-label aux call does the
    # same. Pin both out; the persistent-client path is pinned off suite-wide in conftest.
    async def p_noop_provider_env(*args, **kwargs):
        return None

    async def p_noop_turn_label(*args, **kwargs):
        return None

    monkeypatch.setattr(run_options_mod, "configure_provider_env", p_noop_provider_env, raising=True)
    monkeypatch.setattr(agent_manager, "generate_turn_label", p_noop_turn_label, raising=True)

    async def fake_query(*args, **kwargs):
        yield p_assistant()
        yield p_result()

    monkeypatch.setattr(claude_agent_sdk, "query", fake_query, raising=True)

    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    agent_manager.sessions[session.id] = session
    agent_manager.tasks.pop(session.id, None)

    client = TestClient(main_mod.app)
    try:
        with client.websocket_connect(f"/ws/agents/{session.id}") as ws:
            ws.send_json({"event": "agent:send_message", "data": {"prompt": "hi"}})
            seen = []
            for _ in range(40):
                ev = p_receive_json(ws)
                seen.append(ev.get("event"))
                if (
                    ev.get("event") == "agent:status"
                    and ev.get("data", {}).get("status") == "completed"
                ):
                    break
            else:
                raise AssertionError(f"did not receive completed status; saw events={seen}")
        # the real loop's assistant reply made it all the way back over the WS
        assert "agent:message" in seen
        assert any(m.role == "assistant" and "hello from the loop" in str(m.content)
                   for m in session.messages)
    finally:
        agent_manager.sessions.pop(session.id, None)
        agent_manager.tasks.pop(session.id, None)
