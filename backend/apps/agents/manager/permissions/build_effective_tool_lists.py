"""Build the per-turn effective allowed/disallowed tool lists, the activation+permission gate
the SDK enforces. Pure function over the session's allowed tools, the live builtin-permission
map, and the registered MCP servers; lifted out of the agent loop and covered by the MCP-gate
invariant tests. Returns (allowed, disallowed)."""

from typing import Dict, List, Tuple

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.permissions import path_gate
from backend.apps.agents.manager.prompt.tool_catalog import (
    FULL_TOOLS,
    get_all_known_tool_names,
    get_denied_tool_names,
)
from backend.apps.tools_lib.tools_lib import (
    load_all_tools as load_all_tools,
    sanitize_server_name as sanitize_server_name,
)
from backend.config.headless import apply_unreachable_denies

# Mutation/exec tools a read-only session must never reach: Edit (rewrites files), Bash (rm/mv/overwrite),
# NotebookEdit (rewrites notebooks). Write is intentionally NOT here, the audit needs its one report.
READ_ONLY_BLOCKED_TOOLS = ("Edit", "Bash", "NotebookEdit")


@typechecked
def build_effective_tool_lists(
    session: AgentSession,
    mcp_servers: Dict,
    builtin_perms: Dict[str, str],
    need_web_mcp: bool,
    browser_delegation_tools: List[str],
    invoke_agent_tools: List[str],
) -> Tuple[List[str], List[str]]:
    # Same shadow the server registration takes: anything that would dead-end goes straight onto disallowed instead of being offered and failing when called.
    builtin_perms = apply_unreachable_denies(builtin_perms)
    effective_allowed = [
        t for t in session.allowed_tools
        if t in FULL_TOOLS and builtin_perms.get(t, "always_allow") == "always_allow"
    ]

    effective_disallowed = [
        t for t in FULL_TOOLS
        if builtin_perms.get(t, "always_allow") == "deny"
    ]

    if mcp_servers:
        all_tools_list = load_all_tools()
        for name in mcp_servers:
            if name == "openswarm-core":
                # Every builtin tool rides ONE combined process now (ENG-208), so the old per-server
                # wildcard would blanket gated tools; enumerate per module instead, same policies as
                # when each module was its own process. Module list = what registration wired.
                p_modules = [m for m in mcp_servers[name].get("env", {}).get("OSW_MCP_MODULES", "").split(",") if m]
                from backend.apps.agents import apps_mcp_server, mcp_meta_server, memory_meta_server, schedule_mcp_server, settings_meta_server
                from backend.apps.settings.agent_settings_write_allowed import agent_settings_write_allowed
                from backend.apps.settings.store import load_settings
                # Don't offer a write the route is going to refuse; the route stays the real gate (ENG-284).
                p_may_write = agent_settings_write_allowed(load_settings())
                for p_t in (x["name"] for x in mcp_meta_server.TOOLS + settings_meta_server.TOOLS + apps_mcp_server.TOOLS):
                    if p_t == "SettingsWrite" and not p_may_write:
                        effective_disallowed.append(f"mcp__openswarm-core__{p_t}")
                        continue
                    effective_allowed.append(f"mcp__openswarm-core__{p_t}")
                # Module presence already encodes the Settings memory toggle; absent module = tools not offered.
                if "memory" in p_modules:
                    for p_t in (x["name"] for x in memory_meta_server.TOOLS):
                        effective_allowed.append(f"mcp__openswarm-core__{p_t}")
                if "schedule" in p_modules:
                    for p_t in (x["name"] for x in schedule_mcp_server.TOOLS):
                        effective_allowed.append(f"mcp__openswarm-core__{p_t}")
                if "browser" in p_modules:
                    for bt in browser_delegation_tools:
                        policy = builtin_perms.get(bt, "always_allow")
                        if policy == "always_allow":
                            effective_allowed.append(f"mcp__openswarm-core__{bt}")
                        elif policy == "deny":
                            effective_disallowed.append(f"mcp__openswarm-core__{bt}")
                if "invoke" in p_modules:
                    for it in invoke_agent_tools:
                        policy = builtin_perms.get(it, "always_allow")
                        if policy == "always_allow":
                            effective_allowed.append(f"mcp__openswarm-core__{it}")
                        elif policy == "deny":
                            effective_disallowed.append(f"mcp__openswarm-core__{it}")
                if "spawn" in p_modules:
                    policy = builtin_perms.get("Agent", "always_allow")
                    if policy == "always_allow":
                        effective_allowed.append("mcp__openswarm-core__SpawnAgent")
                    elif policy == "deny":
                        effective_disallowed.append("mcp__openswarm-core__SpawnAgent")
                if "skill" in p_modules:
                    policy = builtin_perms.get("Skill", "always_allow")
                    if policy == "always_allow":
                        effective_allowed.append("mcp__openswarm-core__Skill")
                    else:
                        effective_disallowed.append("mcp__openswarm-core__Skill")
                if "ui" in p_modules:
                    policy = builtin_perms.get("ShowUI", "always_allow")
                    for ui_tool in ("ShowUI", "AskUI"):
                        if policy == "always_allow":
                            effective_allowed.append(f"mcp__openswarm-core__{ui_tool}")
                        else:
                            effective_disallowed.append(f"mcp__openswarm-core__{ui_tool}")
                if "canvas" in p_modules:
                    policy = builtin_perms.get("CanvasCommand", "always_allow")
                    if policy == "always_allow":
                        effective_allowed.append("mcp__openswarm-core__CanvasCommand")
                    elif policy == "deny":
                        effective_disallowed.append("mcp__openswarm-core__CanvasCommand")
                if "ptc" in p_modules:
                    policy = builtin_perms.get("RunToolScript", "always_allow")
                    if policy == "always_allow":
                        effective_allowed.append("mcp__openswarm-core__RunToolScript")
                    elif policy == "deny":
                        effective_disallowed.append("mcp__openswarm-core__RunToolScript")
                if "web" in p_modules:
                    # Honor existing WebSearch/WebFetch permission policy, if the user disabled them in Settings, don't offer the MCP variants either.
                    for wt in ("WebSearch", "WebFetch"):
                        policy = builtin_perms.get(wt, "always_allow")
                        if policy == "always_allow":
                            effective_allowed.append(f"mcp__openswarm-core__{wt}")
                        elif policy == "deny":
                            effective_disallowed.append(f"mcp__openswarm-core__{wt}")
                continue

            tool_def = next(
                (t for t in all_tools_list
                 if t.mcp_config and t.enabled and sanitize_server_name(t.name) == name),
                None,
            )
            if tool_def:
                denied = get_denied_tool_names(tool_def)
                known = get_all_known_tool_names(tool_def)
                for tn in known - denied:
                    policy = tool_def.tool_permissions.get(tn, "ask")
                    if policy == "always_allow":
                        effective_allowed.append(f"mcp__{name}__{tn}")
                for tn in denied:
                    effective_disallowed.append(f"mcp__{name}__{tn}")
            else:
                effective_allowed.append(f"mcp__{name}__*")

    # If the openswarm-web MCP was registered, the CLI's built-in WebSearch/WebFetch are guaranteed to fail (no Anthropic backend). Suppress them so the model picks our MCP variants and doesn't waste a turn on a broken tool.
    if need_web_mcp:
        effective_allowed = [t for t in effective_allowed if t not in ("WebSearch", "WebFetch")]
        for wt_name in ("WebSearch", "WebFetch"):
            if wt_name not in effective_disallowed:
                effective_disallowed.append(wt_name)
    # With the openswarm-ui server live, the built-in AskUserQuestion is swapped for AskUI (same
    # Agent->SpawnAgent playbook: prompt nudges lose to the trained prior, a hard deny doesn't).
    # AskUI's option-list/question-flow cover the flat-choice cases; denying the built-in is what
    # actually routes questions through the rich components.
    if "openswarm-ui" in mcp_servers:
        effective_allowed = [t for t in effective_allowed if t != "AskUserQuestion"]
        if "AskUserQuestion" not in effective_disallowed:
            effective_disallowed.append("AskUserQuestion")
    # Claude's internal Cron* scheduler is denied in favour of the visible native one; withhold it from the SDK so the model doesn't even reach for it.
    for bt in path_gate.CLAUDE_INTERNAL_SCHEDULER_TOOLS:
        if bt not in effective_disallowed:
            effective_disallowed.append(bt)
    # Nothing consumes a between-turn event here, so arming one of these strands the user waiting on a report that can never arrive.
    for bt in path_gate.UNDELIVERABLE_BACKGROUND_TOOLS:
        if bt not in effective_disallowed:
            effective_disallowed.append(bt)
    # The claude_code preset ships its own bare `Skill` tool that reads ~/.claude/skills directly; always withhold it so skills only ever load through our provider-agnostic mcp__openswarm-core__Skill (or not at all).
    if "Skill" not in effective_disallowed:
        effective_disallowed.append("Skill")
    # Read-only session (onboarding's unattended audit over the user's real files): the mutation/exec
    # tools are HARD-blocked, not just left out of allowed, so a background agent can never modify or
    # delete an existing file. Write stays permitted for its single report. Also drop them from allowed
    # in case a preset seeded them, disallowed wins in the SDK but keep the two lists coherent.
    if getattr(session, "read_only", False):
        for dt in READ_ONLY_BLOCKED_TOOLS:
            if dt not in effective_disallowed:
                effective_disallowed.append(dt)
        effective_allowed = [t for t in effective_allowed if t not in READ_ONLY_BLOCKED_TOOLS]
    return effective_allowed, effective_disallowed
