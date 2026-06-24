"""Unit coverage for the extracted SDK permission/pre-tool hooks (gate_hooks). These ran
inside the agent loop's closure before and had no isolated tests; pin the contract now that
they're a module: policy -> allow/deny, and the ToolSearch loop-breaker fire + reset."""

import pytest
from unittest.mock import patch, AsyncMock

from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming.HookContext import HookContext
from backend.apps.agents.manager.permissions import gate_hooks
from backend.apps.agents.manager.permissions.ApprovalDecision import ApprovalDecision
from backend.apps.agents.manager.prompt.prompt_context import TOOLSEARCH_LOOP_THRESHOLD


def p_ctx() -> HookContext:
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    return HookContext(
        session=session,
        session_id=session.id,
        prompt="hi",
        builtin_perms={},
        policy_defaults={},
        sessions={},
    )


@pytest.mark.asyncio
async def test_can_use_tool_always_allow_returns_allow():
    ctx = p_ctx()
    with patch.object(gate_hooks.path_gate, "maybe_override_policy", return_value=("always_allow", None)):
        result = await gate_hooks.can_use_tool(ctx, "Read", {"file_path": "/x"}, None)
    assert isinstance(result, PermissionResultAllow)


@pytest.mark.asyncio
async def test_can_use_tool_deny_returns_deny():
    ctx = p_ctx()
    with patch.object(gate_hooks.path_gate, "maybe_override_policy", return_value=("deny", None)):
        result = await gate_hooks.can_use_tool(ctx, "Bash", {"command": "rm -rf /"}, None)
    assert isinstance(result, PermissionResultDeny)


@pytest.mark.asyncio
async def test_can_use_tool_ask_routes_through_approval():
    ctx = p_ctx()
    with patch.object(gate_hooks.path_gate, "maybe_override_policy", return_value=("ask", None)), \
         patch.object(gate_hooks, "request_user_approval", new=AsyncMock(return_value=ApprovalDecision(behavior="allow"))):
        result = await gate_hooks.can_use_tool(ctx, "Write", {"file_path": "/x"}, None)
    assert isinstance(result, PermissionResultAllow)


@pytest.mark.asyncio
async def test_pre_tool_hook_toolsearch_loopbreaker_fires_at_threshold():
    ctx = p_ctx()
    ctx.ts_loop_count = TOOLSEARCH_LOOP_THRESHOLD - 1
    with patch.object(gate_hooks, "gated_mcp_server_names", return_value=["gmail"]), \
         patch.object(gate_hooks, "toolsearch_loop_redirect", return_value="Stop calling ToolSearch; use MCPActivate"):
        out = await gate_hooks.pre_tool_hook(ctx, {"tool_name": "ToolSearch"}, "tu1", None)
    deny = out["hookSpecificOutput"]
    assert deny["permissionDecision"] == "deny"
    assert "MCPActivate" in deny["permissionDecisionReason"]


@pytest.mark.asyncio
async def test_pre_tool_hook_counter_resets_on_non_toolsearch():
    ctx = p_ctx()
    ctx.ts_loop_count = 5
    with patch.object(gate_hooks.path_gate, "maybe_override_policy", return_value=("always_allow", None)):
        out = await gate_hooks.pre_tool_hook(ctx, {"tool_name": "Read", "tool_input": {}}, "tu1", None)
    assert ctx.ts_loop_count == 0
    assert out == {}
    assert "tu1" in ctx.tool_start_times  # an allowed tool records its start time
