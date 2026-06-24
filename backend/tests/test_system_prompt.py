"""Unit coverage for the extracted per-turn system-prompt assembly. Pins that the base prompt
is composed, the current-time block is always pinned, and view-builder mode appends the live
App Builder skill. The context builders are mocked to None so the test is deterministic and
doesn't depend on dashboard/tool disk state."""

import pytest
from unittest.mock import patch

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.prompt import compose_turn_system_prompt as sp


def p_compose(session: AgentSession):
    with patch.object(sp, "build_browser_context", return_value=None), \
         patch.object(sp, "build_mcp_registry_summary", return_value=None), \
         patch.object(sp, "build_selected_app_context", return_value=None), \
         patch.object(sp, "build_selected_settings_context", return_value=None):
        return sp.compose_turn_system_prompt(
            session, mode_sys_prompt=None, default_system_prompt="You are a helpful agent.",
            selected_browser_ids=None, selected_app_output_ids=None, selected_setting_ids=None,
        )


def test_base_composition_includes_default_and_time_pin():
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    out = p_compose(session)
    assert "You are a helpful agent." in out
    assert "<current_time>" in out  # the wall-clock pin is always appended


def test_view_builder_appends_live_skill_block():
    session = AgentSession(name="t", model="sonnet", dashboard_id="d", mode="view-builder")
    with patch("backend.apps.outputs.view_builder_templates.load_app_builder_skill", return_value="SKILL BODY"):
        out = p_compose(session)
    assert "<app_builder_reference>" in out
    assert "SKILL BODY" in out


def test_selected_app_context_is_appended_when_present():
    session = AgentSession(name="t", model="sonnet", dashboard_id="d")
    with patch.object(sp, "build_browser_context", return_value=None), \
         patch.object(sp, "build_mcp_registry_summary", return_value=None), \
         patch.object(sp, "build_selected_app_context", return_value="<picked_app>/x</picked_app>"), \
         patch.object(sp, "build_selected_settings_context", return_value=None):
        out = sp.compose_turn_system_prompt(
            session, mode_sys_prompt=None, default_system_prompt="base",
            selected_browser_ids=None, selected_app_output_ids=["app-1"], selected_setting_ids=None,
        )
    assert "<picked_app>/x</picked_app>" in out
