"""Prompt composition helpers extracted from AgentManager.

All functions are stateless — they accept data as parameters instead of
relying on ``self``.
"""

from __future__ import annotations

import logging
from typing import Any

from backend.apps.modes.modes import load_mode
from backend.apps.common.mcp_utils import sanitize_server_name as _sanitize_server_name
from backend.apps.agents.execution.prompt_context import resolve_context_paths
from backend.apps.tools_lib.models import BUILTIN_TOOLS


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
    browser_ctx: str | None = None,
) -> str | None:
    parts = [p for p in (default_prompt, mode_prompt, session_prompt,
                         connected_tools_ctx, browser_ctx) if p]
    return "\n\n".join(parts) if parts else None


def resolve_forced_tools(
    forced_tools: list[str] | None,
    load_all_tools_fn,
) -> str:
    if not forced_tools:
        return ""
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
