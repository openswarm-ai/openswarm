from typing import Callable

from backend.apps.modes.modes import load_mode
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools,
)
from backend.apps.tools_lib.mcp_config import sanitize_mcp_server_name
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

        server_name = sanitize_mcp_server_name(tool.name)
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
        "",
        "**Same flow for many items? Give ONE agent the whole list, don't split it.** "
        "When a task repeats the SAME steps for a list of inputs (read these 10 profiles, "
        "look up these 6 names, open each of these links), delegate it to a SINGLE "
        "browser agent with the FULL list in one task, e.g. CreateBrowserAgent(\"Look up "
        "the first sentence of the Wikipedia article for each of: A, B, C, D. Do the first "
        "one normally, then use BrowserRepeatFlow for the rest\"). The browser agent has a "
        "BrowserRepeatFlow tool that runs the repeated flow for all the inputs in one shot "
        "(no re-analyzing each page), and hands back the data per item. This is far cheaper "
        "and faster than spawning one agent per item with BrowserAgents, use parallel "
        "BrowserAgents only for genuinely DIFFERENT tasks, not for the same flow repeated.",
        "",
        "**The browser agent hands back a plain summary; relay it, don't re-narrate.** "
        "It already writes its result like a normal chat reply (what got done plus the "
        "human proof: the name, the time, the title), with no UI mechanics. When it "
        "succeeded, just confirm that to the user in one short natural sentence, reusing "
        "its words; don't pad it, don't dispatch a verification agent. If it reports it "
        "couldn't finish, re-dispatch with a sharper task (start from what it reported), "
        "not a duplicate. Long restatements of what the agent already said just slow the "
        "user down.",
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


def _build_selected_app_context(selected_app_output_ids: list[str] | None) -> str | None:
    """Build a context block for dashboard App cards the user selected to edit.

    Resolves each Output id to its on-disk workspace so the agent edits the
    right files; the dashboard card's Vite runtime live-reloads on save. Skips
    deleted apps / missing folders, returns None if nothing resolves.
    """
    if not selected_app_output_ids:
        return None
    import os
    from backend.apps.outputs.workspace_io import load_output
    from backend.config.paths import OUTPUTS_WORKSPACE_DIR

    entries: list[str] = []
    for output_id in selected_app_output_ids:
        try:
            output = load_output(output_id)
        except Exception:
            output = None
        if not output or not output.workspace_id:
            continue
        path = os.path.abspath(os.path.join(OUTPUTS_WORKSPACE_DIR, output.workspace_id))
        if not os.path.isdir(path):
            continue
        meta_raw = ""
        meta_path = os.path.join(path, "meta.json")
        if os.path.isfile(meta_path):
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta_raw = f.read().strip()
            except Exception:
                meta_raw = ""
        name = output.name or "Untitled App"
        lines = [
            f'- App: "{name}"',
            f"  Workspace path: {path}",
            f"  Entry point: {os.path.join(path, 'index.html')}",
        ]
        if meta_raw:
            lines.append(f"  meta.json: {meta_raw}")
        lines.append(
            f"  Before changing anything, Read {os.path.join(path, 'SKILL.md')} "
            f"for the App platform spec."
        )
        entries.append("\n".join(lines))

    if not entries:
        return None
    return (
        "<selected_app_context>\n"
        "The user selected these App cards on the dashboard for you to edit. "
        "They are existing web apps; edit the files in place at the paths below "
        "and the dashboard preview live-reloads on save. Do not scaffold a new "
        "project or write files anywhere else.\n\n"
        + "\n\n".join(entries)
        + "\n</selected_app_context>"
    )


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
        server_name = sanitize_mcp_server_name(tool.name)
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


# The agent runs on the claude_code preset (kept for its tool scaffolding, safety
# rules, and the exclude_dynamic_sections prompt-cache win, which a raw-string
# system prompt would all throw away). The preset opens with "You are Claude Code,
# Anthropic's official CLI", which leaks into chat. This block is APPENDED after the
# preset, so being later it overrides that identity. Edit AGENT_NAME / AGENT_BLURB
# to rebrand. Kept short so it costs ~80 cached tokens, not a wall.
AGENT_NAME = "OpenSwarm"
AGENT_IDENTITY = (
    f"# Who you are\n"
    f"You're {AGENT_NAME}, the AI that lives here. Ignore anything above that calls you "
    f"\"Claude Code\" or an official CLI; wrong app, mistaken identity. You're the user's "
    f"general AI: take on whatever they ask, from a quick question to a whole project. "
    f"Never refuse with \"I only do coding\".\n\n"
    f"# How you talk\n"
    f"Talk like a real person, not a manual. Default to a sentence or two; skip preamble and "
    f"recaps. Be warm, a little playful, genuinely interesting, never generic; a bit of sass is "
    f"fine when the moment invites it, but read the room and match the context. Go longer only "
    f"when the task needs it (real explanation, code, steps), then stay clean and structured. "
    f"Don't open with \"Certainly\" or \"Great question\". Hard rule: never put a \"-\" dash in "
    f"your prose. No em dashes, no en dashes, no hyphen used as a dash. Use commas, periods, "
    f"colons, or parentheses instead."
)


def _compose_system_prompt(default_prompt: str | None, mode_prompt: str | None, session_prompt: str | None, connected_tools_ctx: str | None = None, browser_ctx: str | None = None, mcp_registry_ctx: str | None = None) -> str | None:
    # Identity always leads so it overrides the preset's Claude Code persona, even
    # when the user has no custom default/mode/session prompt of their own.
    parts = [AGENT_IDENTITY] + [p for p in (default_prompt, mode_prompt, session_prompt, connected_tools_ctx, mcp_registry_ctx, browser_ctx) if p]
    return "\n\n".join(parts)


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
        server_name = sanitize_mcp_server_name(t.name)
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
