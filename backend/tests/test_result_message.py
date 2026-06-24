"""Direct coverage for the extracted ResultMessage handler: it writes the session's token
totals, recomputes cost off-Anthropic-rate routes (free routes zero out), broadcasts the
context-usage update, and resets the per-turn state. The harness covers the happy path; these
pin the token math, the free-route cost rule, and the reset."""

import pytest
from unittest.mock import patch, AsyncMock

from claude_agent_sdk import ResultMessage

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming.state import TurnState, ThinkingState
from backend.apps.agents.manager.streaming import handle_result_message as result_message
from backend.apps.settings.settings import load_settings


def p_result(usage=None, cost=None):
    m = ResultMessage(subtype="success", duration_ms=100, duration_api_ms=80, is_error=False,
                      num_turns=1, session_id="sdk-1",
                      usage=usage or {"input_tokens": 100, "output_tokens": 50})
    if cost is not None:
        try:
            m.total_cost_usd = cost
        except Exception:
            object.__setattr__(m, "total_cost_usd", cost)
    return m


def p_fixt():
    return AgentSession(name="t", model="sonnet", dashboard_id="d"), TurnState(), ThinkingState()


@pytest.mark.asyncio
async def test_writes_session_tokens_and_emits_context_update():
    session, turn, thinking = p_fixt()
    events = []

    async def fake_send(sid, ev, data):
        events.append(ev)

    with patch.object(result_message.ws_manager, "send_to_session", new=fake_send):
        await result_message.handle_result_message(
            p_result(usage={"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 20}),
            session, session.id, turn, thinking, {}, "sonnet", "anthropic", load_settings())
    assert session.tokens["input"] == 120        # 100 fresh + 0 create + 20 cache-read
    assert session.tokens["input_fresh"] == 100
    assert session.tokens["output"] == 50
    assert "agent:context_update" in events


@pytest.mark.asyncio
async def test_free_route_zeroes_cost():
    session, turn, thinking = p_fixt()
    with patch.object(result_message.ws_manager, "send_to_session", new=AsyncMock()):
        await result_message.handle_result_message(
            p_result(cost=9.99), session, session.id, turn, thinking, {}, "cc/opus", "anthropic", load_settings())
    assert session.cost_usd == 0.0  # cc/ is a subscription (server-funded) route, never billed per-token


@pytest.mark.asyncio
async def test_resets_per_turn_state_at_completion():
    session, turn, thinking = p_fixt()
    turn.output_tokens = 999
    turn.tool_count = 5
    thinking.total_ms = 100  # text_parts left empty so no pill emit fires in the test
    with patch.object(result_message.ws_manager, "send_to_session", new=AsyncMock()):
        await result_message.handle_result_message(
            p_result(), session, session.id, turn, thinking, {}, "sonnet", "anthropic", load_settings())
    assert turn.output_tokens == 0
    assert turn.tool_count == 0
    assert thinking.total_ms == 0
    assert thinking.block_starts == {}
