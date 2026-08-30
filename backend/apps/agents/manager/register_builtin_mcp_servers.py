"""Register the builtin tool servers into the per-turn mcp_servers map as ONE combined stdio
process ("openswarm-core"), instead of one python interpreter per server (ENG-208). The SAME
permission conditions that used to skip a server's process now skip its module inside the combined
process (OSW_MCP_MODULES), so a denied capability's tools stay exactly as absent as before. The
server script lives in the agents package, so we resolve its directory off that package here, NOT
off a dir a caller passes in: a caller in a moved file would compute the wrong dir (this bit us
once). Returns the browser/invoke delegation tool-name lists the allowlist gate needs."""

import os
import sys
from typing import Dict, List, Optional, Tuple

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.auth import get_auth_token
from backend.config.headless import apply_unreachable_denies


@typechecked
def register_builtin_mcp_servers(
    mcp_servers: Dict,
    session: AgentSession,
    builtin_perms: Dict[str, str],
    selected_browser_ids: Optional[List[str]],
    selected_app_output_ids: Optional[List[str]],
) -> Tuple[List[str], List[str]]:
    import backend.apps.agents as p_agents_pkg
    agents_dir = os.path.dirname(p_agents_pkg.__file__)
    # With no renderer for a webview and no human for a prompt, we shadow the map once here and let the existing deny short-circuits skip those modules; nothing below may read the un-shadowed one.
    builtin_perms = apply_unreachable_denies(builtin_perms)
    from backend.apps.agents.manager.delegation_tool_names import BROWSER_DELEGATION_TOOLS
    browser_delegation_tools = list(BROWSER_DELEGATION_TOOLS)
    # ReadAgentWork rides InvokeAgent's policy unless set on its own: a user who denied delegation
    # denied reading other sessions too, and inheriting is how that stays true without them having
    # to find a second toggle (never widen a tool surface silently).
    invoke_agent_tools = ["InvokeAgent", "ReadAgentWork"]
    builtin_perms.setdefault("ReadAgentWork", builtin_perms.get("InvokeAgent", "always_allow"))

    # The always-on trio: MCP discovery (the activation gate's one doorway), agent-editable
    # Settings, and CreateApp.
    modules = ["meta", "settings", "apps"]

    # Memory tools ride the same Settings toggle as the prompt block, so "off" means zero bytes AND zero tools.
    try:
        from backend.apps.settings.settings import load_settings
        if getattr(load_settings(), "memory_enabled", True):
            modules.append("memory")
    except Exception:
        modules.append("memory")

    browser_all_denied = all(
        builtin_perms.get(t, "always_allow") == "deny"
        for t in browser_delegation_tools
    )
    if not browser_all_denied:
        modules.append("browser")

    if not all(builtin_perms.get(t, "always_allow") == "deny" for t in invoke_agent_tools):
        modules.append("invoke")

    # SpawnAgent replaces the CLI's built-in Agent tool (blocked in RunOptions); gated by the same "Agent" permission so the Tools-page toggle keeps working.
    if builtin_perms.get("Agent", "always_allow") != "deny":
        modules.append("spawn")

    # Skill module: gated on at least one non-built-in skill existing AND Skill not being denied, so we never offer a tool with an empty catalog. Kept in sync with build_installed_skills_catalog, which omits the catalog under the same conditions.
    if builtin_perms.get("Skill", "always_allow") != "deny":
        try:
            from backend.apps.skills.skills import sync_skills
            has_loadable_skill = any(not s.built_in and s.enabled for s in sync_skills())
        except Exception:
            has_loadable_skill = False
        if has_loadable_skill:
            modules.append("skill")

    # ShowUI renders rich inline components from the tool_call input (display only, server just validates); AskUI renders an interactive component and BLOCKS on /api/ui-requests/wait until the user answers in the transcript. Gated on the ShowUI builtin perm.
    if builtin_perms.get("ShowUI", "always_allow") != "deny":
        modules.append("ui")

    # Schedule module: ScheduleWorkflow + CRUD + step editing so the agent (and the workflow Edit Agent) can build and schedule recurring work via the native scheduler. The 4 scheduling tools are force-gated in path_gate; Cron* is denied in build_effective_tool_lists.
    modules.append("schedule")

    # RunToolScript (PTC): script-chained tool calls whose intermediates never enter context; inner calls are allowlisted in the server itself.
    if builtin_perms.get("RunToolScript", "always_allow") != "deny":
        modules.append("ptc")

    # Canvas control after spawn (ENG-334): move/collapse/tile/close/tidy; close is scoped server-side to the caller's own cards.
    if builtin_perms.get("CanvasCommand", "always_allow") != "deny":
        modules.append("canvas")

    # Only the card the user actually picked in select-mode gets claimed for the task, so the sub drives that one instead of opening its own duplicate. Passing EVERY dashboard card here (the old behavior) made the sub force-grab a random, usually-parked card and never navigate it, which broke the bulk of browser tasks.
    pre_selected_bids = [b for b in (selected_browser_ids or []) if b]
    # Apps the user selected this turn; the AppAgent tool may only target these (anti-hallucination gate in the MCP server, which reads this at startup).
    selected_app_ids = [a for a in (selected_app_output_ids or []) if a]

    combined_path = os.path.join(agents_dir, "combined_meta_mcp_server.py")
    mcp_servers["openswarm-core"] = {
        "command": sys.executable,
        "args": [combined_path],
        "env": {
            "OSW_MCP_MODULES": ",".join(modules),
            "OPENSWARM_PORT": os.environ.get("OPENSWARM_PORT", "8324"),
            "OPENSWARM_AUTH_TOKEN": get_auth_token(),
            "OPENSWARM_PARENT_SESSION_ID": session.id,
            "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
            "OPENSWARM_AGENT_MODEL": session.model,
            "OPENSWARM_PRE_SELECTED_BROWSER_IDS": ",".join(pre_selected_bids),
            "OPENSWARM_SELECTED_APP_IDS": ",".join(selected_app_ids),
        },
        "type": "stdio",
    }
    return browser_delegation_tools, invoke_agent_tools
