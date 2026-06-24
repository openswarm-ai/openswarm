"""Direct coverage for the extracted StreamEvent handler. The streaming harness yields whole
AssistantMessage/ResultMessage envelopes, never partial StreamEvents, so this is the only test
that drives the incremental content_block_start/delta/stop path the live UI actually uses."""

import pytest
from unittest.mock import patch, AsyncMock

from claude_agent_sdk.types import StreamEvent

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming.state import TurnState, ThinkingState
from backend.apps.agents.manager.streaming import handle_stream_event as stream_event


def p_ev(event: dict) -> StreamEvent:
    return StreamEvent(uuid="u", session_id="s", event=event)


def p_fixt():
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    return session, TurnState(), ThinkingState(), {}


@pytest.mark.asyncio
async def test_content_block_start_text_inits_stream_message():
    session, turn, thinking, lp = p_fixt()
    with patch.object(stream_event.ws_manager, "send_to_session", new=AsyncMock()) as send:
        await stream_event.handle_stream_event(
            p_ev({"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}),
            session, session.id, turn, thinking, lp)
    assert turn.stream_text_msg_id is not None
    assert turn.stream_block_index_map[0] == turn.stream_text_msg_id
    send.assert_awaited()  # agent:stream_start broadcast


@pytest.mark.asyncio
async def test_text_delta_accumulates_and_mirrors_live_partial():
    session, turn, thinking, lp = p_fixt()
    turn.stream_text_msg_id = "m1"
    turn.stream_block_index_map[0] = "m1"
    with patch.object(stream_event.ws_manager, "send_to_session", new=AsyncMock()):
        await stream_event.handle_stream_event(
            p_ev({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hello"}}),
            session, session.id, turn, thinking, lp)
    assert turn.stream_text_accum == "Hello"
    assert turn.assistant_text_chars == 5
    assert lp[session.id].text == "Hello"  # the live-partial mirror the manager reads on resume


@pytest.mark.asyncio
async def test_tool_use_start_increments_stream_tool_count():
    session, turn, thinking, lp = p_fixt()
    with patch.object(stream_event.ws_manager, "send_to_session", new=AsyncMock()):
        await stream_event.handle_stream_event(
            p_ev({"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "name": "Read"}}),
            session, session.id, turn, thinking, lp)
    assert turn.tool_count == 1
    assert 1 in turn.stream_block_index_map


@pytest.mark.asyncio
async def test_thinking_block_start_then_stop_pops_and_accumulates():
    session, turn, thinking, lp = p_fixt()
    with patch.object(stream_event.ws_manager, "send_to_session", new=AsyncMock()):
        await stream_event.handle_stream_event(
            p_ev({"type": "content_block_start", "index": 2, "content_block": {"type": "thinking"}}),
            session, session.id, turn, thinking, lp)
        assert 2 in thinking.block_starts
        await stream_event.handle_stream_event(
            p_ev({"type": "content_block_stop", "index": 2}),
            session, session.id, turn, thinking, lp)
    assert 2 not in thinking.block_starts  # the start was popped on stop
    assert thinking.total_ms >= 0  # elapsed accumulated server-side
