"""Direct coverage for the extracted AssistantMessage handler. The harness drives the common
paths; these pin the branches it doesn't: the router-auth-expiry friendly card, tool-call
commit, and per-turn output-token accumulation."""

import pytest
from unittest.mock import patch, AsyncMock

from claude_agent_sdk import AssistantMessage
from claude_agent_sdk.types import TextBlock, ToolUseBlock

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming.state import TurnState, ThinkingState
from backend.apps.agents.manager.streaming import handle_assistant_message as assistant_message


def p_asst(blocks, usage=None):
    return AssistantMessage(content=blocks, model="sonnet", message_id="m1", stop_reason="end_turn",
                            session_id="s", usage=usage or {"input_tokens": 1, "output_tokens": 1})


def p_fixt():
    return AgentSession(name="t", model="sonnet", dashboard_id="d"), TurnState(), ThinkingState()


@pytest.mark.asyncio
async def test_plain_text_commits_assistant_message():
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text="Hello there")]), session, session.id, turn, thinking, {}, {})
    assert any(m.role == "assistant" and "Hello there" in str(m.content) for m in session.messages)
    assert turn.number == 1


@pytest.mark.asyncio
async def test_router_auth_error_surfaces_card_not_assistant_text():
    session, turn, thinking = p_fixt()
    txt = "[codex/gpt-5] Failed to authenticate: 401 provided authentication token is expired"
    events = []

    async def fake_send(sid, event, data):
        events.append(event)

    with patch.object(assistant_message.ws_manager, "send_to_session", new=fake_send):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text=txt)]), session, session.id, turn, thinking, {}, {})
    assert any(m.role == "system" for m in session.messages)        # friendly card
    assert not any(m.role == "assistant" for m in session.messages)  # NOT committed as the reply
    assert "agent:auth_error" in events


@pytest.mark.asyncio
async def test_tool_use_block_commits_tool_call():
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([ToolUseBlock(id="tu1", name="Read", input={"file_path": "/x"})]),
            session, session.id, turn, thinking, {}, {})
    assert any(m.role == "tool_call" for m in session.messages)


@pytest.mark.asyncio
async def test_output_tokens_accumulate_onto_turn():
    session, turn, thinking = p_fixt()
    with patch.object(assistant_message.ws_manager, "send_to_session", new=AsyncMock()):
        await assistant_message.handle_assistant_message(
            p_asst([TextBlock(text="hi")], usage={"input_tokens": 10, "output_tokens": 42}),
            session, session.id, turn, thinking, {}, {})
    assert turn.output_tokens == 42
