"""Assemble the full per-turn system prompt for an agent run: the base composed prompt
(default + mode + session) plus the appended context blocks (browser selection, MCP registry
summary, a current-time pin, the App Builder skill, picked app cards, picked Settings rows).
Lifted out of the agent loop; calls the prompt_context builders directly (no manager needed)."""

import os
from datetime import datetime
from typing import List, Optional

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.prompt.tool_catalog import get_all_tool_names
from backend.apps.agents.manager.prompt.prompt_context import (
    build_app_runtime_contract,
    build_browser_context,
    build_installed_skills_catalog,
    build_mcp_registry_summary,
    build_selected_app_context,
    build_selected_settings_context,
    compose_system_prompt,
)


@typechecked
def compose_turn_system_prompt(
    session: AgentSession,
    mode_sys_prompt: Optional[str],
    default_system_prompt: Optional[str],
    selected_browser_ids: Optional[List[str]],
    selected_app_output_ids: Optional[List[str]],
    selected_setting_ids: Optional[List[str]],
) -> Optional[str]:
    # MCP servers and their tool inventories are intentionally NOT injected into the system prompt: the CLI's deferred-tool pool already exposes them by name via ToolSearch, and eagerly listing connected MCPs (account emails, full tool enumerations) here would defeat the deferral and leak every integration into every turn. The model discovers MCPs only when it actively calls ToolSearch; only the gated registry summary goes in.
    browser_ctx = build_browser_context(session.dashboard_id, selected_browser_ids=selected_browser_ids)
    mcp_registry_ctx = build_mcp_registry_summary(session.allowed_tools, session.active_mcps, get_all_tool_names)
    skills_catalog_ctx = build_installed_skills_catalog()
    composed_prompt = compose_system_prompt(
        default_system_prompt,
        mode_sys_prompt,
        session.system_prompt,
        browser_ctx,
        mcp_registry_ctx,
        skills_catalog_ctx,
    )

    # Pin the agent's notion of "now" to the host wall clock + zone so it can answer day-of-week questions without hallucinating.
    try:
        from zoneinfo import ZoneInfo
        # Best-effort IANA name for the host. Mirrors apps/service/client.py.
        tz_name = os.environ.get("OPENSWARM_TIMEZONE", "").strip()
        if not tz_name:
            try:
                from tzlocal import get_localzone_name  # type: ignore
                tz_name = get_localzone_name() or ""
            except Exception:
                tz_name = ""
        tz_name = tz_name or "UTC"
        now_local = datetime.now(ZoneInfo(tz_name))
        tz_abbr = now_local.strftime("%Z") or tz_name
        time_ctx = (
            "<current_time>\n"
            f"Today is {now_local.strftime('%A, %B %-d, %Y')}.\n"
            f"Local time: {now_local.strftime('%-I:%M %p')} {tz_abbr} ({tz_name}).\n"
            "Use this as ground truth for any date/time/day-of-week question.\n"
            "</current_time>"
        )
        composed_prompt = (composed_prompt + "\n\n" + time_ctx) if composed_prompt else time_ctx
    except Exception:
        pass

    if session.mode == "view-builder":
        # Read the LIVE skill content rather than a frozen-at-import constant. The skill is registered at ~/.claude/skills/app_builder_skill.md; user edits in the Skills page land there and propagate to the agent's prompt next turn without a restart.
        from backend.apps.outputs.view_builder_templates import load_app_builder_skill
        skill_block = f"<app_builder_reference>\n{load_app_builder_skill()}\n</app_builder_reference>"
        composed_prompt = f"{composed_prompt}\n\n{skill_block}" if composed_prompt else skill_block
        # Appended AFTER the reference, and never sourced from it: the skill is a user-editable file seeded once per install, so a stale or edited copy silently drops whatever it omits. Platform mechanics have to reach the agent regardless of what that file says.
        contract_block = build_app_runtime_contract(session.cwd)
        composed_prompt = f"{composed_prompt}\n\n{contract_block}"
    else:
        # Every other mode gets one line of discovery instead of the whole reference: CreateApp's result carries the reference when actually used, so the base prompt stays cheap.
        apps_note = (
            "<apps_capability>\n"
            "You can build real web apps for the user: when they ask for an app, tool, game, or dashboard, "
            "call the CreateApp tool — it seeds a workspace and puts a live preview card on their dashboard, "
            "then you write the code. To change an existing app, have the user select its card (or use the "
            "workspace path in your context) and edit the files directly.\n"
            "</apps_capability>"
        )
        composed_prompt = f"{composed_prompt}\n\n{apps_note}" if composed_prompt else apps_note

    # App cards the user picked via the dashboard element picker: give the agent each app's on-disk path + meta + SKILL.md pointer so it can edit them in place (the dashboard card's runtime live-reloads). Additive and independent of view-builder mode above.
    app_ctx = build_selected_app_context(selected_app_output_ids)
    if app_ctx:
        composed_prompt = f"{composed_prompt}\n\n{app_ctx}" if composed_prompt else app_ctx

    # The user can point the agent at specific Settings rows. Targeting aid only; the settings tools are always on regardless.
    settings_ctx = build_selected_settings_context(selected_setting_ids)
    if settings_ctx:
        composed_prompt = f"{composed_prompt}\n\n{settings_ctx}" if composed_prompt else settings_ctx

    return composed_prompt
