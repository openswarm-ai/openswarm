"""Prompt-building helpers extracted from AgentManager.

All functions are stateless — they accept data as parameters instead of
relying on ``self``.
"""

from __future__ import annotations

import json as _json
import logging
import os
from typing import Any

from backend.apps.agents.models import AgentSession
from backend.apps.modes.modes import load_mode
from backend.apps.outputs.outputs import _load_all as load_all_outputs
from backend.apps.common.mcp_utils import sanitize_server_name as _sanitize_server_name

logger = logging.getLogger(__name__)


def resolve_mode(
    mode_id: str,
    get_all_tool_names_fn,
) -> tuple[list[str], str | None, str | None]:
    """Return (tools, system_prompt, default_folder) from the mode store."""
    mode_def = load_mode(mode_id)
    if mode_def:
        tools = mode_def.tools if mode_def.tools is not None else get_all_tool_names_fn()
        return tools, mode_def.system_prompt, mode_def.default_folder
    return get_all_tool_names_fn(), None, None


def compose_system_prompt(
    default_prompt: str | None,
    mode_prompt: str | None,
    session_prompt: str | None,
    connected_tools_ctx: str | None = None,
    outputs_ctx: str | None = None,
    browser_ctx: str | None = None,
) -> str | None:
    parts = [p for p in (default_prompt, mode_prompt, session_prompt,
                         connected_tools_ctx, outputs_ctx, browser_ctx) if p]
    return "\n\n".join(parts) if parts else None


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


def build_outputs_context() -> str | None:
    all_outputs = load_all_outputs()
    if not all_outputs:
        return None
    sections: list[str] = []
    for out in all_outputs:
        lines = [f"- **{out.name}** (id: `{out.id}`)"]
        if out.description:
            lines.append(f"  Description: {out.description}")
        schema_str = _json.dumps(out.input_schema, indent=2)
        lines.append(f"  Input schema:\n```json\n{schema_str}\n```")
        sections.append("\n".join(lines))
    return (
        "<available_views>\n"
        "The following reusable View artifacts are available. "
        "Use the RenderOutput tool to invoke one by providing its output_id "
        "and the required input_data matching its schema.\n\n"
        + "\n\n".join(sections)
        + "\n</available_views>"
    )


def build_browser_context(
    dashboard_id: str | None,
    selected_browser_ids: list[str] | None = None,
) -> str | None:
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


def get_pre_selected_browser_ids(dashboard_id: str | None) -> list[str]:
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


def resolve_forced_tools(
    forced_tools: list[str] | None,
    load_all_tools_fn,
) -> str:
    if not forced_tools:
        return ""
    from backend.apps.tools_lib.models import BUILTIN_TOOLS
    desc_map: dict[str, str] = {t.name: t.description for t in BUILTIN_TOOLS}
    tool_to_server: dict[str, str] = {}
    tool_to_email: dict[str, str] = {}
    for t in load_all_tools_fn():
        if not t.enabled or not t.tool_permissions:
            continue
        tool_descs = t.tool_permissions.get("_tool_descriptions", {})
        server_name = _sanitize_server_name(t.name)
        for tn, td in tool_descs.items():
            desc_map[tn] = td
            tool_to_server[tn] = server_name
            if t.connected_account_email:
                tool_to_email[tn] = t.connected_account_email

    lines: list[str] = []
    for name in forced_tools:
        desc = desc_map.get(name, "")
        line = f"- {name}: {desc}" if desc else f"- {name}"
        server = tool_to_server.get(name)
        if server:
            line += f"\n  (MCP server: {server})"
        email = tool_to_email.get(name)
        if email:
            line += f"\n  (connected account: {email} — use this for any email parameter)"
        lines.append(line)

    return (
        "<forced_tools>\n"
        "The user explicitly requested these tools be used. "
        "Prioritize using them to address the user's request.\n"
        + "\n".join(lines)
        + "\n</forced_tools>"
    )


def resolve_attached_skills(attached_skills: list | None) -> str:
    if not attached_skills:
        return ""
    sections: list[str] = []
    for skill in attached_skills:
        name = skill.get("name", "Unknown")
        content = skill.get("content", "")
        if content:
            sections.append(f"[Using skill: {name}]\n\n{content}")
    return "\n\n".join(sections)


def build_prompt_content(
    prompt: str,
    images: list | None = None,
    context_paths: list | None = None,
    forced_tools: list[str] | None = None,
    attached_skills: list | None = None,
    load_all_tools_fn=None,
):
    context_text = resolve_context_paths(context_paths)
    forced_tools_text = resolve_forced_tools(forced_tools, load_all_tools_fn)
    skills_text = resolve_attached_skills(attached_skills)

    parts = [p for p in (forced_tools_text, context_text, skills_text, prompt) if p]
    full_prompt = "\n\n".join(parts)

    if not images:
        return full_prompt
    content: list[dict[str, Any]] = [{"type": "text", "text": full_prompt}]
    for img in images:
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": img.get("media_type", "image/png"),
                "data": img["data"],
            },
        })
    return content
