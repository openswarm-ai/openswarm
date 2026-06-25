from typing import Callable, Dict, List, Optional, Tuple

from typeguard import typechecked

from backend.apps.modes.modes import load_mode
from backend.apps.tools_lib.tools_lib import (
    load_all_tools as load_all_tools,
    sanitize_server_name as sanitize_server_name,
)
from backend.apps.agents.manager.prompt.tool_catalog import is_fully_denied


@typechecked
def resolve_mode(mode_id: str, get_all_tool_names: Callable[[], List[str]]) -> Tuple[List[str], Optional[str], Optional[str]]:
    """Return (tools, system_prompt, default_folder) resolved from the mode store."""
    mode_def = load_mode(mode_id)
    if mode_def:
        tools = mode_def.tools if mode_def.tools is not None else get_all_tool_names()
        return tools, mode_def.system_prompt, mode_def.default_folder
    return get_all_tool_names(), None, None


# A run of this many ToolSearch calls with no other tool between them is the "looping on ToolSearch" wedge: the model hunts for a gated MCP server's tools, which ToolSearch can never see, gets empty results, and retries. Two free calls (a power user with many activated MCPs may legitimately ToolSearch to load a deferred tool); redirect on the third.
TOOLSEARCH_LOOP_THRESHOLD = 3


@typechecked
def toolsearch_loop_redirect(consecutive_toolsearch: int, gated_servers: List[str]) -> Optional[str]:
    """The feedback to hand a model that's stuck calling ToolSearch in a row.
    None until it crosses the threshold; then a steer toward MCPActivate (the
    only path to a gated server) plus a reminder its other tools are already
    loaded. Pure so the loop-break boundary is unit-testable."""
    if consecutive_toolsearch < TOOLSEARCH_LOOP_THRESHOLD:
        return None
    reason = (
        "ToolSearch can't load anything here, every tool you can use is already "
        "active and callable by name, so there's nothing to search for. "
    )
    if gated_servers:
        reason += (
            "If you need an app you don't see yet (email, calendar, drive, etc.), "
            "it's gated: call MCPActivate(server_name) with one of these and its "
            f"tools become callable next turn: {', '.join(gated_servers)}. "
        )
    reason += "Stop calling ToolSearch."
    return reason


@typechecked
def build_browser_context(dashboard_id: Optional[str], selected_browser_ids: Optional[List[str]] = None) -> Optional[str]:
    """Build a context block listing browser cards and delegation instructions.

    Only browser cards explicitly selected by the user are included.
    If none are selected, no browser card details are exposed.
    """
    if not dashboard_id:
        return None
    try:
        from backend.apps.dashboards.dashboards import load as load_dashboard
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


@typechecked
def build_selected_app_context(selected_app_output_ids: Optional[List[str]]) -> Optional[str]:
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

    entries: List[str] = []
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


@typechecked
def build_selected_settings_context(selected_setting_ids: Optional[List[str]]) -> Optional[str]:
    """Context block when the user points the agent at specific Settings rows.

    A targeting aid, NOT a gate: the settings tools (SettingsRead/SettingsWrite)
    are always available regardless. This just focuses the agent on the exact
    fields the user clicked. Ids are AppSettings field names (e.g. 'theme',
    'default_model'), so no label map to drift out of date."""
    ids = [s for s in (selected_setting_ids or []) if s]
    if not ids:
        return None
    bullets = "\n".join(f"- {fid}" for fid in ids)
    return (
        "<selected_settings>\n"
        "The user pointed you at these specific OpenSwarm Settings fields. Focus "
        "on them: call SettingsRead to see their current values, then "
        "SettingsWrite to change what the user asked for. Leave unrelated "
        "settings alone.\n"
        f"{bullets}\n"
        "</selected_settings>"
    )


@typechecked
def build_mcp_registry_summary(allowed_tools: List[str], active_mcps: List[str], get_all_tool_names: Callable[[], List[str]]) -> Optional[str]:
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
    active_lines: List[str] = []
    available_lines: List[str] = []
    for tool in mcp_tools:
        tool_ref = f"mcp:{tool.name}"
        if tool_ref not in allowed_tools and allowed_tools != get_all_tool_names():
            continue
        if is_fully_denied(tool):
            continue
        server_name = sanitize_server_name(tool.name)
        desc = (getattr(tool, "description", None) or "").strip()
        if not desc:
            # Fall back to a generic blurb keyed on the tool name so the model still has *some* signal to MCPSearch against.
            desc = f"{tool.name} integration"
        line = f"- `{server_name}`, {desc}"
        if server_name in active_set:
            active_lines.append(line)
        else:
            available_lines.append(line)

    if not active_lines and not available_lines:
        return None

    # Static preamble first (kept byte-identical across users so it caches), then the per-session server list. Worked-example uses generic placeholders so a Pro Anthropic prompt-cache hit isn't broken by one user's connector names differing from another's.
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
        "1b. The native `ToolSearch` tool CANNOT see these servers, they're "
        "hidden from it until activated, so searching for them returns nothing "
        "and just burns turns. Never ToolSearch for an app/integration; go "
        "straight to MCPActivate."
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


# The agent runs on the claude_code preset (kept for its tool scaffolding, safety rules, and the exclude_dynamic_sections prompt-cache win, which a raw-string system prompt would all throw away). The preset opens with "You are Claude Code, Anthropic's official CLI", which leaks into chat. This block is APPENDED after the preset, so being later it overrides that identity. Edit AGENT_NAME / AGENT_BLURB to rebrand. Kept short so it costs ~80 cached tokens, not a wall.
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


@typechecked
def compose_system_prompt(default_prompt: Optional[str], mode_prompt: Optional[str], session_prompt: Optional[str], browser_ctx: Optional[str] = None, mcp_registry_ctx: Optional[str] = None) -> Optional[str]:
    # Identity always leads so it overrides the preset's Claude Code persona, even when the user has no custom default/mode/session prompt of their own.
    parts = [AGENT_IDENTITY] + [p for p in (default_prompt, mode_prompt, session_prompt, mcp_registry_ctx, browser_ctx) if p]
    return "\n\n".join(parts)


@typechecked
def resolve_forced_tools(forced_tools: Optional[List[str]]) -> str:
    """Build a context block describing explicitly requested tools."""
    if not forced_tools:
        return ""
    from backend.apps.tools_lib.models import BUILTIN_TOOLS
    desc_map: Dict[str, str] = {t.name: t.description for t in BUILTIN_TOOLS}
    tool_to_server: Dict[str, str] = {}
    tool_to_email: Dict[str, str] = {}
    for t in load_all_tools():
        if not t.enabled or not t.tool_permissions:
            continue
        tool_descs = t.tool_permissions.get("_tool_descriptions", {})
        server_name = sanitize_server_name(t.name)
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


@typechecked
def resolve_attached_skills(attached_skills: Optional[List]) -> str:
    """Build a context block injecting attached skill content into the prompt.

    For a multi-file (folder) skill we inject the SKILL.md body as text AND point
    the agent at the folder so it can read supporting files (scripts, templates)
    on demand with the normal Read/Glob/Bash tools. That keeps skills fully
    provider-agnostic: plain prompt text plus universal file tools, identical on
    Claude, OpenAI, Gemini, or any custom model routed through 9router. The
    folder lookup is resolved backend-side from the skill id so the frontend
    send payload stays a simple {id, name, content}."""
    if not attached_skills:
        return ""
    folder_by_id: Dict[str, str] = {}
    try:
        from backend.apps.skills.skills import sync_skills
        for s in sync_skills():
            if s.dir_path and s.has_supporting_files:
                folder_by_id[s.id] = s.dir_path
    except Exception:
        folder_by_id = {}

    sections = []
    for skill in attached_skills:
        name = skill.get("name", "Unknown")
        content = skill.get("content", "")
        if not content:
            continue
        block = f"[Using skill: {name}]\n\n{content}"
        folder = folder_by_id.get(skill.get("id", ""))
        if folder:
            block += (
                f"\n\nThis skill bundles supporting files in {folder}. "
                "Read them with your normal file tools (Read / Glob / Bash) when "
                "the steps above call for one; don't guess their contents."
            )
        sections.append(block)
    return "\n\n".join(sections)
