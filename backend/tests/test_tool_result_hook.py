"""Unit coverage for the extracted PostToolUse hook (tool_result_hook). The streaming harness
mocks claude_agent_sdk.query, so it never fires the SDK's PostToolUse hooks; this pins the
behavior directly: a tool result becomes a tool_result message, and an Agent tool spawns a
sub-session into the manager's LIVE registry (the InstanceOf[dict] sharing, the subtle bit)."""

import pytest
from unittest.mock import patch, AsyncMock, MagicMock

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming.HookContext import HookContext
from backend.apps.agents.manager.streaming import post_tool_hook as tool_result_hook
from backend.apps.agents.manager import view_builder_state


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


@pytest.mark.asyncio
async def test_view_builder_dep_install_broadcasts_app_deps_changed():
    """An npm install in a view-builder session must tell the app card this turn
    changed deps (agent:app_deps_changed), so its turn-finish reload restarts Vite
    instead of soft-reloading a preview that can't see the new packages."""
    registry: dict = {}
    ctx = p_ctx(registry)
    ctx.session.mode = "view-builder"
    with patch.object(tool_result_hook.ws_manager, "send_to_session", new=AsyncMock()) as send:
        await tool_result_hook.post_tool_hook(
            ctx, {"tool_name": "Bash", "tool_response": "added 3 packages",
                  "tool_input": {"command": "npm install recharts"}}, "tu1", None
        )
    events = [c.args[1] for c in send.await_args_list]
    assert "agent:app_deps_changed" in events


@pytest.mark.asyncio
async def test_view_builder_plain_write_does_not_flag_deps_changed():
    """A plain file edit must NOT escalate the reload; only dep changes do."""
    registry: dict = {}
    ctx = p_ctx(registry)
    ctx.session.mode = "view-builder"
    with patch.object(tool_result_hook.ws_manager, "send_to_session", new=AsyncMock()) as send:
        await tool_result_hook.post_tool_hook(
            ctx, {"tool_name": "Write", "tool_response": "ok",
                  "tool_input": {"file_path": "/ws/frontend/src/App.tsx", "content": "x"}}, "tu1", None
        )
    events = [c.args[1] for c in send.await_args_list]
    assert "agent:app_deps_changed" not in events


def p_app_manager(build_errors=(), console_errors=()) -> MagicMock:
    fake = MagicMock()
    fake.drain_errors_for_path.return_value = list(build_errors)
    fake.drain_frontend_errors_for_path.return_value = list(console_errors)
    return fake


async def p_write(ctx, fake_manager, file_path="/ws/frontend/src/App.tsx") -> str:
    with patch.object(tool_result_hook.ws_manager, "send_to_session", new=AsyncMock()), \
         patch("backend.apps.outputs.runtime.manager", fake_manager):
        await tool_result_hook.post_tool_hook(
            ctx, {"tool_name": "Write", "tool_response": "ok",
                  "tool_input": {"file_path": file_path, "content": "x"}}, "tu1", None
        )
    view_builder_state.view_builder_dirty_sessions.discard(ctx.session_id)
    return str(ctx.session.messages[-1].content)


@pytest.mark.asyncio
async def test_view_builder_write_surfaces_build_errors_into_the_tool_result():
    """Regression: this drain sat behind an `elif` on the view-builder reload branch, so a
    frontend write took that branch instead -- the App Builder was the one agent that never
    saw its own vite/babel/tsc errors after a write."""
    ctx = p_ctx({})
    ctx.session.mode = "view-builder"
    body = await p_write(ctx, p_app_manager(build_errors=["[plugin:vite] SyntaxError: Unexpected token"]))
    assert "Build server reported" in body
    assert "SyntaxError" in body


@pytest.mark.asyncio
async def test_write_surfaces_app_console_errors_as_a_separate_note():
    ctx = p_ctx({})
    ctx.session.mode = "view-builder"
    body = await p_write(ctx, p_app_manager(console_errors=["TypeError: x is not a function"]))
    assert "The app's console logged" in body
    assert "TypeError: x is not a function" in body


@pytest.mark.asyncio
async def test_createapp_write_from_another_mode_still_surfaces_errors():
    """An agent in normal chat mode editing an app it made with CreateApp gets the same feedback."""
    ctx = p_ctx({})  # default mode, not view-builder
    body = await p_write(ctx, p_app_manager(build_errors=["Traceback (most recent call last)"]))
    assert "Traceback" in body


@pytest.mark.asyncio
async def test_write_outside_any_app_workspace_adds_no_note():
    ctx = p_ctx({})
    body = await p_write(ctx, p_app_manager(), file_path="/some/other/repo/main.py")
    assert "Build server reported" not in body
    assert "The app's console logged" not in body
