"""Context-building helpers for agent prompts.

Assembles tool context, output schemas, browser instructions,
file/directory context, and directory trees.
"""

from __future__ import annotations

import logging
import os

from backend.apps.common.mcp_utils import sanitize_server_name as _sanitize_server_name

from backend.apps.dashboards.dashboards import _load as load_dashboard


logger = logging.getLogger(__name__)


def build_connected_tools_context(
    allowed_tools: list[str],
    load_all_tools_fn,
    get_all_tool_names_fn,
    is_fully_denied_fn,
    get_denied_tool_names_fn,
) -> str | None:
    all_tools = load_all_tools_fn()
    mcp_tools = [t for t in all_tools if t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")]

    sections: list[str] = []
    for tool in mcp_tools:
        tool_ref = f"mcp:{tool.name}"
        if tool_ref not in allowed_tools and allowed_tools != get_all_tool_names_fn():
            continue
        if is_fully_denied_fn(tool):
            continue

        server_name = _sanitize_server_name(tool.name)
        denied = get_denied_tool_names_fn(tool)
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
                f"\"{tool.connected_account_email}\" automatically — do NOT ask the user."
            )
        tool_names = list(tool_descs.keys())
        if tool_names:
            lines.append(f"  Available tools ({len(tool_names)}): {', '.join(tool_names)}")
        sections.append("\n".join(lines))

    not_connected = [
        t for t in all_tools
        if t.mcp_config and t.enabled
        and t.auth_type in ("oauth2", "env_vars")
        and t.auth_status != "connected"
    ]
    if not_connected:
        nc_lines = ["Tools installed but not yet connected (user needs to authorize in Settings → Tools):"]
        for t in not_connected:
            nc_lines.append(f"  - {t.name}")
        sections.append("\n".join(nc_lines))

    if not sections:
        return None
    return (
        "<connected_mcp_tools>\n"
        "The following MCP tool servers are connected and available. "
        "Use them directly when relevant to the user's request.\n\n"
        + "\n\n".join(sections)
        + "\n</connected_mcp_tools>"
    )


def build_browser_context(
    dashboard_id: str | None,
    selected_browser_ids: list[str] | None = None,
) -> str | None:
    if not dashboard_id:
        return None
    try:
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


def get_pre_selected_browser_ids(dashboard_id: str | None) -> list[str]:
    if not dashboard_id:
        return []
    try:
        dashboard = load_dashboard(dashboard_id)
    except Exception:
        return []
    raw = dashboard.model_dump(mode="json")
    browser_cards = raw.get("layout", {}).get("browser_cards", {})
    return [card.get("browser_id", "") for card in browser_cards.values() if card.get("browser_id")]


def resolve_context_paths(context_paths: list | None) -> str:
    if not context_paths:
        return ""
    sections: list[str] = []
    for cp in context_paths:
        path = cp.get("path", "")
        cp_type = cp.get("type", "file")
        if not path or not os.path.exists(path):
            sections.append(f"[Context: {path} — not found]")
            continue
        if cp_type == "file" and os.path.isfile(path):
            try:
                with open(path, "r", errors="replace") as f:
                    content = f.read(512_000)
                sections.append(f"<context_file path=\"{path}\">\n{content}\n</context_file>")
            except Exception as e:
                sections.append(f"[Context: {path} — error reading: {e}]")
        elif cp_type == "directory" and os.path.isdir(path):
            tree_lines = build_dir_tree(path, max_depth=4)
            sections.append(f"<context_directory path=\"{path}\">\n{chr(10).join(tree_lines)}\n</context_directory>")
        else:
            sections.append(f"[Context: {path} — type mismatch]")
    return "\n\n".join(sections)


def build_dir_tree(root: str, max_depth: int = 4, prefix: str = "") -> list[str]:
    lines: list[str] = []
    try:
        entries = sorted(os.listdir(root))
    except PermissionError:
        return [f"{prefix}[permission denied]"]
    dirs = [e for e in entries if not e.startswith(".") and os.path.isdir(os.path.join(root, e))]
    files = [e for e in entries if not e.startswith(".") and os.path.isfile(os.path.join(root, e))]
    for f in files:
        lines.append(f"{prefix}{f}")
    for d in dirs:
        lines.append(f"{prefix}{d}/")
        if max_depth > 1:
            sub = build_dir_tree(os.path.join(root, d), max_depth - 1, prefix + "  ")
            lines.extend(sub)
    return lines
