"""Agents stopped mid-task by a misfired nudge reported "the user told me to stop", and others
read hidden harness messages as prompt injection (field reports, 2026-08-16). Mechanism: every
hidden prompt (silent-quit nudges incl. the FINAL one that literally opens "Stop. Do not call any
more tools.", lost-step retries, auth heals, context-break continuations) rides the USER role, so
the model's misattribution is honest from its chair. Seal: one attribution prefix at the ONE send
chokepoint, so no hidden message can ever read as the user's words.
"""
import inspect

import pytest
from unittest.mock import AsyncMock, patch

from backend.apps.agents.core.models import AgentSession


@pytest.mark.asyncio
async def test_hidden_prompt_gets_the_attribution_prefix():
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.manager import Messaging
    session = AgentSession(id="hm-1", name="t", model="sonnet", dashboard_id="d")
    agent_manager.sessions["hm-1"] = session
    try:
        with patch.object(Messaging, "ws_manager") as p_ws, \
             patch.object(agent_manager, "run_agent_loop", new=AsyncMock(), create=True):
            p_ws.send_to_session = AsyncMock()
            try:
                await agent_manager.send_message("hm-1", "Stop. Do not call any more tools.", hidden=True)
            except Exception:
                pass  # downstream turn machinery may bail in a unit context; the append happened first
        hidden = [m for m in session.messages if m.role == "user" and m.hidden]
        assert hidden, "hidden message never appended"
        assert hidden[-1].content.startswith("[Automated message from OpenSwarm itself"), \
            "a nudge the model attributes to the user is the fabricated-stop bug"
    finally:
        agent_manager.sessions.pop("hm-1", None)


@pytest.mark.asyncio
async def test_visible_user_prompt_is_untouched():
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.manager import Messaging
    session = AgentSession(id="hm-2", name="t", model="sonnet", dashboard_id="d")
    agent_manager.sessions["hm-2"] = session
    try:
        with patch.object(Messaging, "ws_manager") as p_ws, \
             patch.object(agent_manager, "run_agent_loop", new=AsyncMock(), create=True):
            p_ws.send_to_session = AsyncMock()
            try:
                await agent_manager.send_message("hm-2", "please stop and summarize", hidden=False)
            except Exception:
                pass
        visible = [m for m in session.messages if m.role == "user" and not m.hidden]
        assert visible and visible[-1].content == "please stop and summarize", "real user words must never be rewritten"
    finally:
        agent_manager.sessions.pop("hm-2", None)


def test_no_double_prefix():
    from backend.apps.agents.manager import Messaging
    src = inspect.getsource(Messaging)
    assert 'not prompt.startswith("[Automated")' in src, "re-sent continuations must not stack prefixes"
