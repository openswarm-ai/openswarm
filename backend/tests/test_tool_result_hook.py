"""Unit coverage for the extracted PostToolUse hook (tool_result_hook). The streaming harness
mocks claude_agent_sdk.query, so it never fires the SDK's PostToolUse hooks; this pins the
behavior directly: a tool result becomes a tool_result message, and an Agent tool spawns a
sub-session into the manager's LIVE registry (the InstanceOf[dict] sharing, the subtle bit)."""

import pytest
from unittest.mock import patch, AsyncMock

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming.HookContext import HookContext
from backend.apps.agents.manager.streaming import post_tool_hook as tool_result_hook


def p_ctx(registry: dict) -> HookContext:
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    registry[session.id] = session
    return HookContext(
        session=session,
        session_id=session.id,
        prompt="hi",
        builtin_perms={},
        policy_defaults={},
        sessions=registry,
    )


@pytest.mark.asyncio
async def test_normal_tool_result_appends_message_and_continues():
    registry: dict = {}
    ctx = p_ctx(registry)
    before = len(ctx.session.messages)
    with patch.object(tool_result_hook.ws_manager, "send_to_session", new=AsyncMock()) as send:
        out = await tool_result_hook.post_tool_hook(
            ctx, {"tool_name": "Read", "tool_response": "file body", "tool_input": {"file_path": "/x"}}, "tu1", None
        )
    assert out == {"continue_": True}
    assert len(ctx.session.messages) == before + 1
    msg = ctx.session.messages[-1]
    assert msg.role == "tool_result"
    assert "file body" in str(msg.content)
    send.assert_awaited()  # the tool_result is broadcast to the UI


@pytest.mark.asyncio
async def test_agent_tool_spawns_subsession_into_live_registry():
    registry: dict = {}
    ctx = p_ctx(registry)
    parent_id = ctx.session_id
    raw = {
        "content": [{"type": "text", "text": "sub-agent did the work"}],
        "usage": {"input_tokens": 7, "output_tokens": 3},
        "total_cost_usd": 0.01,
        "model": "sonnet",
    }
    with patch.object(tool_result_hook.ws_manager, "send_to_session", new=AsyncMock()), \
         patch.object(tool_result_hook.ws_manager, "broadcast_global", new=AsyncMock()):
        out = await tool_result_hook.post_tool_hook(
            ctx, {"tool_name": "Agent", "tool_response": raw, "tool_input": {"prompt": "do x"}}, "tu1", None
        )
    assert out == {"continue_": True}
    # exactly one NEW session registered (besides the parent), parented correctly
    children = [s for sid, s in registry.items() if sid != parent_id]
    assert len(children) == 1
    child = children[0]
    assert child.parent_session_id == parent_id
    assert child.active_mcps == []  # context-isolation invariant: no inherited activations
    assert "sub-agent did the work" in str(child.messages[-1].content)
