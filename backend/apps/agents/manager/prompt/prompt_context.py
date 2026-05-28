from typing import Callable

from backend.apps.modes.modes import load_mode
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools,
    _sanitize_server_name,
)
from backend.apps.agents.manager.prompt.tool_catalog import _get_denied_tool_names, _is_fully_denied


def _resolve_mode(mode_id: str, get_all_tool_names: Callable[[], list[str]]) -> tuple[list[str], str | None, str | None]:
    """Return (tools, system_prompt, default_folder) resolved from the mode store."""
    mode_def = load_mode(mode_id)
    if mode_def:
        tools = mode_def.tools if mode_def.tools is not None else get_all_tool_names()
        return tools, mode_def.system_prompt, mode_def.default_folder
    return get_all_tool_names(), None, None


def _build_connected_tools_context(allowed_tools: list[str], get_all_tool_names: Callable[[], list[str]]) -> str | None:
    """Build a context block describing connected MCP tools and their accounts.

    Tools set to 'deny' and fully-denied servers are excluded.
    """
    all_tools = load_all_tools()
    mcp_tools = [t for t in all_tools if t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")]

    sections = []
    for tool in mcp_tools:
        tool_ref = f"mcp:{tool.name}"
        if tool_ref not in allowed_tools and allowed_tools != get_all_tool_names():
            continue

        if _is_fully_denied(tool):
            continue

        server_name = _sanitize_server_name(tool.name)
        denied = _get_denied_tool_names(tool)
        tool_descs = {
            k: v for k, v in tool.tool_permissions.get("_tool_descriptions", {}).items()
            if k not in denied
        }
        if not tool_descs:
            continue

        lines = [f"MCP Server: {server_name}"]
        lines.append(f"  Status: {tool.auth_status}")

        if tool.connected_account_email:
            lines.append(f"  Connected account: {tool.connected_account_email}")
            lines.append(
                f"  IMPORTANT: When calling tools from this server that require an email "
                f"parameter (e.g. user_google_email, user_email), always use "
                f"\"{tool.connected_account_email}\" automatically, do NOT ask the user."
            )

        # Discord guild scoping, hard restriction. The bot may technically
        # be in other servers (across other OpenSwarm users), but this
        # specific user only authorized these guild IDs.
        if tool.name.lower() == "discord":
            guilds = tool.oauth_tokens.get("guilds") or []
            if guilds:
                guild_descriptions = ", ".join(
                    f"{g.get('name', 'Unknown')} ({g.get('id', '')})" for g in guilds
                )
                allowed_ids = [g.get("id", "") for g in guilds if g.get("id")]
                lines.append(
                    f"  AUTHORIZED DISCORD SERVERS (guild_ids): {guild_descriptions}"
                )
                lines.append(
                    f"  HARD RESTRICTION: You MUST only call Discord tools that operate on "
                    f"these guild_ids: {allowed_ids}. NEVER call Discord tools on any other "
                    f"guild_id even if the bot has access to it. NEVER list, search, or "
                    f"enumerate servers outside this list. If a user asks about a server "
                    f"not in this list, refuse and tell them to authorize it via the Connect "
                    f"Discord button. This is a security boundary, not a preference."
                )
            else:
                lines.append(
                    f"  No Discord servers authorized yet. Tell the user to click "
                    f"'Connect Discord' to add a server before attempting any Discord actions."
                )

        tool_names = list(tool_descs.keys())
        if tool_names:
            lines.append(f"  Available tools ({len(tool_names)}): {', '.join(tool_names)}")

        sections.append("\n".join(lines))

    if not sections:
        return None
    return (
        "<connected_mcp_tools>\n"
        "The following MCP tool servers are connected and available. "
        "Use them directly when relevant to the user's request.\n\n"
        + "\n\n".join(sections)
        + "\n</connected_mcp_tools>"
    )


def _build_browser_context(dashboard_id: str | None, selected_browser_ids: list[str] | None = None) -> str | None:
    """Build a context block listing browser cards and delegation instructions.

    Only browser cards explicitly selected by the user are included.
    If none are selected, no browser card details are exposed.
    """
    if not dashboard_id:
        return None
    try:
        from backend.apps.dashboards.dashboards import _load as load_dashboard
        dashboard = load_dashboard(dashboard_id)
    except Exception:
        return None
    raw = dashboard.model_dump(mode="json")
    browser_cards = raw.get("layout", {}).get("browser_cards", {})

    lines = [
        "<browser_agent_instructions>",
        "You have access to browser automation through the CreateBrowserAgent, BrowserAgent, and BrowserAgents tools.",
        "",
        "- **CreateBrowserAgent(task, url?)**: Create a new browser card and run a task on it. "
        "Use this when you need a fresh browser. Optionally provide a starting URL.",
        "- **BrowserAgent(browser_id, task)**: Delegate a task to an existing browser card. "
        "The browser agent will autonomously navigate, click, type, and interact with the page, then return a summary and screenshot.",
        "- **BrowserAgents(tasks)**: Run multiple browser tasks in parallel on existing browser cards. "
        "Each task requires a browser_id.",
        "",
        "You do NOT have direct access to low-level browser tools (click, type, screenshot, etc.). "
        "Instead, describe what you want accomplished and the browser agent will handle the details.",
    ]

    if browser_cards and selected_browser_ids:
        visible_cards = [
            card for card in browser_cards.values()
            if card.get("browser_id", "") in selected_browser_ids
        ]
        if visible_cards:
            lines.append("")
            lines.append("The user selected these browser cards for you to work with:")
            for card in visible_cards:
                bid = card.get("browser_id", "")
                tabs = card.get("tabs", [])
                active_tab_id = card.get("activeTabId", "")
                active_tab = next((t for t in tabs if t.get("id") == active_tab_id), None)
                url = (active_tab or {}).get("url", card.get("url", ""))
                title = (active_tab or {}).get("title", "")
                lines.append(f"- browser_id: \"{bid}\"")
                if title:
                    lines.append(f"  Title: {title}")
                if url:
                    lines.append(f"  URL: {url}")

    lines.append("</browser_agent_instructions>")
    return "\n".join(lines)


def _get_pre_selected_browser_ids(dashboard_id: str | None) -> list[str]:
    """Return browser_ids of all browser cards currently on the dashboard."""
    if not dashboard_id:
        return []
    try:
        from backend.apps.dashboards.dashboards import _load as load_dashboard
        dashboard = load_dashboard(dashboard_id)
    except Exception:
        return []
    raw = dashboard.model_dump(mode="json")
    browser_cards = raw.get("layout", {}).get("browser_cards", {})
    return [card.get("browser_id", "") for card in browser_cards.values() if card.get("browser_id")]


def _build_mcp_registry_summary(allowed_tools: list[str], active_mcps: list[str], get_all_tool_names: Callable[[], list[str]]) -> str | None:
    """Compact registry of installed MCP servers, one line per server.

    This is the visible surface that drives the activation gate: the model
    sees which servers exist and what they're for, but cannot call any
    unactivated server's tools (the dispatch-layer filter in
    _build_mcp_servers blocks that). To use a server, the model must call
    MCPSearch (to find the right one) and then MCPActivate, which fires a
    HITL prompt; on approve, the server's tools become callable next turn.

    Schemas are NOT included here, that's the whole point. A 30-server
    registry costs ~1KB; the previous full-schema dump cost ~30-80KB.
    """
    all_tools = load_all_tools()
    mcp_tools = [
        t for t in all_tools
        if t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")
    ]
    if not mcp_tools:
        return None

    active_set = set(active_mcps or [])
    active_lines: list[str] = []
    available_lines: list[str] = []
    for tool in mcp_tools:
        tool_ref = f"mcp:{tool.name}"
        if tool_ref not in allowed_tools and allowed_tools != get_all_tool_names():
            continue
        if _is_fully_denied(tool):
            continue
        server_name = _sanitize_server_name(tool.name)
        desc = (getattr(tool, "description", None) or "").strip()
        if not desc:
            # Fall back to a generic blurb keyed on the tool name so the
            # model still has *some* signal to MCPSearch against.
            desc = f"{tool.name} integration"
        line = f"- `{server_name}`, {desc}"
        if server_name in active_set:
            active_lines.append(line)
        else:
            available_lines.append(line)

    if not active_lines and not available_lines:
        return None

    # Static preamble first (kept byte-identical across users so it caches),
    # then the per-session server list. Worked-example uses generic
    # placeholders so a Pro Anthropic prompt-cache hit isn't broken by
    # one user's connector names differing from another's.
    sections = ["<mcp_servers>"]
    sections.append(
        "MCP servers are gated: their tools are uncallable until the user "
        "approves an MCPActivate request. To use one below, call MCPSearch "
        "(if unsure which) then MCPActivate(server_name); after approval the "
        "server's tools (`mcp__<server>__<tool>`) become callable next turn."
    )
    sections.append("")
    sections.append("## Rules")
    sections.append(
        "1. If the user's request needs a server below that isn't Active, "
        "your FIRST tool call must be MCPSearch or MCPActivate. Ignore any "
        "`mcp__*__authenticate` helpers, those are legacy shims; always go "
        "through MCPActivate."
    )
    sections.append(
        "1a. NEVER call any tool whose name begins with `mcp__claude_ai_` "
        "(claude.ai-connected partner shims). They bypass the OpenSwarm "
        "gate and don't share auth with this app. If the user wants Gmail/"
        "Calendar/Drive, the equivalent OpenSwarm server is listed below; "
        "activate that one via MCPActivate instead."
    )
    sections.append(
        "2. After MCPActivate returns, end the turn, a follow-up turn fires "
        "automatically with the new tools available."
    )
    sections.append(
        "3. Don't ask 'should I activate X?' first, MCPActivate already "
        "triggers an approval prompt."
    )
    sections.append("")
    sections.append("## Example")
    sections.append(
        "User asks for email; no email server is Active. First tool call: "
        "`MCPActivate(server_name=\"<email-server>\", reason=\"...\")`. End "
        "turn. Next turn: call the activated server's email tool."
    )
    sections.append("")
    if active_lines:
        sections.append("Active (callable now):")
        sections.extend(active_lines)
    if available_lines:
        sections.append("\nAvailable (not yet activated):")
        sections.extend(available_lines)
    sections.append("</mcp_servers>")
    return "\n".join(sections)


def _compose_system_prompt(default_prompt: str | None, mode_prompt: str | None, session_prompt: str | None, connected_tools_ctx: str | None = None, browser_ctx: str | None = None, mcp_registry_ctx: str | None = None) -> str | None:
    parts = [p for p in (default_prompt, mode_prompt, session_prompt, connected_tools_ctx, mcp_registry_ctx, browser_ctx) if p]
    return "\n\n".join(parts) if parts else None


def _resolve_forced_tools(forced_tools: list[str] | None) -> str:
    """Build a context block describing explicitly requested tools."""
    if not forced_tools:
        return ""
    from backend.apps.tools_lib.models import BUILTIN_TOOLS
    desc_map: dict[str, str] = {t.name: t.description for t in BUILTIN_TOOLS}
    tool_to_server: dict[str, str] = {}
    tool_to_email: dict[str, str] = {}
    for t in load_all_tools():
        if not t.enabled or not t.tool_permissions:
            continue
        tool_descs = t.tool_permissions.get("_tool_descriptions", {})
        server_name = _sanitize_server_name(t.name)
        for tn, td in tool_descs.items():
            desc_map[tn] = td
            tool_to_server[tn] = server_name
            if t.connected_account_email:
                tool_to_email[tn] = t.connected_account_email

    lines = []
    for name in forced_tools:
        desc = desc_map.get(name, "")
        line = f"- {name}: {desc}" if desc else f"- {name}"
        server = tool_to_server.get(name)
        if server:
            line += f"\n  (MCP server: {server})"
        email = tool_to_email.get(name)
        if email:
            line += f"\n  (connected account: {email}, use this for any email parameter)"
        lines.append(line)

    return (
        "<forced_tools>\n"
        "The user explicitly requested these tools be used. "
        "Prioritize using them to address the user's request.\n"
        + "\n".join(lines)
        + "\n</forced_tools>"
    )


def _resolve_attached_skills(attached_skills: list | None) -> str:
    """Build a context block injecting attached skill content into the prompt."""
    if not attached_skills:
        return ""
    sections = []
    for skill in attached_skills:
        name = skill.get("name", "Unknown")
        content = skill.get("content", "")
        if content:
            sections.append(f"[Using skill: {name}]\n\n{content}")
    return "\n\n".join(sections)
