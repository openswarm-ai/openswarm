"""Unit coverage for the extracted Stop hook (the App Builder render gate). Not exercised by
the streaming harness (Stop fires from SDK internals), so pin it directly: the gate is inert
off view-builder mode / when not dirty, and blocks the stop when the preview errors under cap."""

import pytest
from unittest.mock import patch, MagicMock

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming.HookContext import HookContext
from backend.apps.agents.manager.streaming import stop_hook as stop_hook_mod
from backend.apps.agents.manager import view_builder_state


def p_ctx(mode: str) -> HookContext:
    session = AgentSession(name="t", model="sonnet", dashboard_id="d", mode=mode)
    return HookContext(
        session=session, session_id=session.id, prompt="hi",
        builtin_perms={}, policy_defaults={}, sessions={},
    )


@pytest.mark.asyncio
async def test_stop_hook_inert_when_not_view_builder():
    ctx = p_ctx("agent")
    assert await stop_hook_mod.stop_hook(ctx, {}, None, None) == {}


@pytest.mark.asyncio
async def test_stop_hook_inert_when_not_dirty():
    ctx = p_ctx("view-builder")  # dirty set is empty -> nothing to gate
    assert await stop_hook_mod.stop_hook(ctx, {}, None, None) == {}


@pytest.mark.asyncio
async def test_stop_hook_blocks_on_render_error_under_cap():
    ctx = p_ctx("view-builder")
    sid = ctx.session.id
    view_builder_state.view_builder_dirty_sessions.add(sid)
    fake_runtime = MagicMock()
    fake_runtime.get.return_value = object()  # workspace exists
    fake_runtime.get_render_state_for_workspace.return_value = ("error", "boom traceback")
    try:
        with patch("backend.apps.outputs.runtime.manager", fake_runtime):
            out = await stop_hook_mod.stop_hook(ctx, {}, None, None)
        assert out["decision"] == "block"
        assert "failed to render" in out["reason"]
        assert "boom traceback" in out["reason"]
    finally:
        view_builder_state.view_builder_dirty_sessions.discard(sid)
        view_builder_state.view_builder_render_retry_counts.pop(sid, None)
