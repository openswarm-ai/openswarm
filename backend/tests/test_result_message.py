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
async def test_error_shaped_result_raises_after_accounting():
    # is_error / error_* subtype used to be consumed as a normal end-of-turn (silent success).
    session, turn, thinking = p_fixt()
    m = ResultMessage(subtype="error_during_execution", duration_ms=100, duration_api_ms=80,
                      is_error=True, num_turns=1, session_id="sdk-1",
                      usage={"input_tokens": 100, "output_tokens": 50},
                      errors=["tool crashed hard"])
    with patch.object(result_message.ws_manager, "send_to_session", new=AsyncMock()):
        with pytest.raises(result_message.TurnResultError) as exc:
            await result_message.handle_result_message(
                m, session, session.id, turn, thinking, {}, "sonnet", "anthropic", load_settings())
    assert "tool crashed hard" in str(exc.value)
    assert session.tokens["output"] == 50  # token accounting still lands before the raise


@pytest.mark.asyncio
async def test_max_tokens_and_refusal_stops_raise_even_with_success_subtype():
    for stop_reason, phrase in (("max_tokens", "maximum output length"), ("refusal", "refused")):
        session, turn, thinking = p_fixt()
        m = ResultMessage(subtype="success", duration_ms=100, duration_api_ms=80,
                          is_error=False, num_turns=1, session_id="sdk-1",
                          usage={"input_tokens": 10, "output_tokens": 5}, stop_reason=stop_reason)
        with patch.object(result_message.ws_manager, "send_to_session", new=AsyncMock()):
            with pytest.raises(result_message.TurnResultError) as exc:
                await result_message.handle_result_message(
                    m, session, session.id, turn, thinking, {}, "sonnet", "anthropic", load_settings())
        assert phrase in str(exc.value)


@pytest.mark.asyncio
async def test_success_result_never_raises():
    # The mutation pair for the error detection: the happy path must stay a normal completion.
    session, turn, thinking = p_fixt()
    m = ResultMessage(subtype="success", duration_ms=100, duration_api_ms=80,
                      is_error=False, num_turns=1, session_id="sdk-1",
                      usage={"input_tokens": 10, "output_tokens": 5}, stop_reason="end_turn",
                      permission_denials=[{"tool_name": "Bash"}])
    with patch.object(result_message.ws_manager, "send_to_session", new=AsyncMock()):
        await result_message.handle_result_message(
            m, session, session.id, turn, thinking, {}, "sonnet", "anthropic", load_settings())
    assert session.tokens["output"] == 5


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


@pytest.mark.asyncio
async def test_context_meter_prefers_last_step_over_cumulative_billing():
    # A 9-step turn's result usage sums input across steps (billing); the meter must show the last step's request size (real context). The 925K/1M incident read the sum.
    session, turn, thinking = p_fixt()
    turn.last_step_input = 70_454
    payloads = []

    async def fake_send(sid, ev, data):
        if ev == "agent:context_update":
            payloads.append(data)

    with patch.object(result_message.ws_manager, "send_to_session", AsyncMock(side_effect=fake_send)):
        await result_message.handle_result_message(
            p_result(usage={"input_tokens": 2_023, "cache_read_input_tokens": 500_000, "cache_creation_input_tokens": 86_972, "output_tokens": 1_210}),
            session, "sid", turn, thinking, {}, "cc/claude-opus-5", "anthropic", load_settings(),
        )
    assert session.tokens["input"] == 70_454
    assert payloads and payloads[0]["input_tokens"] == 70_454


@pytest.mark.asyncio
async def test_context_meter_falls_back_to_result_usage_without_step_readings():
    session, turn, thinking = p_fixt()
    with patch.object(result_message.ws_manager, "send_to_session", AsyncMock()):
        await result_message.handle_result_message(
            p_result(usage={"input_tokens": 1_000, "cache_read_input_tokens": 2_000, "output_tokens": 10}),
            session, "sid", turn, thinking, {}, "sonnet", "anthropic", load_settings(),
        )
    assert session.tokens["input"] == 3_000
