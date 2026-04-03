"""MCP server building, tool-policy resolution, and tool-name helpers.

Extracted from AgentManager to keep each module focused on a single concern.
"""

from __future__ import annotations

import logging
import re as _re

from backend.apps.common.mcp_utils import sanitize_server_name as _sanitize_server_name
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools,
    derive_mcp_config,
    load_builtin_permissions,
    refresh_google_token,
)

logger = logging.getLogger(__name__)

FULL_TOOLS = [
    "Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion",
    "WebSearch", "WebFetch", "NotebookEdit", "TodoWrite",
    "EnterPlanMode", "ExitPlanMode", "EnterWorktree",
    "TaskOutput", "TaskStop",
    "CronCreate", "CronList", "CronDelete",
    "RenderOutput",
    "InvokeAgent",
    "Agent",
]


def _get_denied_tool_names(tool) -> set[str]:
    """Return the set of MCP sub-tool names whose permission is 'deny'."""
    return {
        key for key, value in tool.tool_permissions.items()
        if not key.startswith("_") and value == "deny"
    }


def _get_all_known_tool_names(tool) -> set[str]:
    """Return all known sub-tool names for an MCP tool."""
    return set(tool.tool_permissions.get("_tool_descriptions", {}).keys())


def _is_fully_denied(tool) -> bool:
    """True when every known sub-tool on this MCP server is set to 'deny'."""
    known = _get_all_known_tool_names(tool)
    if not known:
        return False
    return known <= _get_denied_tool_names(tool)


def get_all_tool_names() -> list[str]:
    """FULL_TOOLS + installed MCP tool identifiers (mcp:<tool_name>).

    Builtin tools set to 'deny' and MCP servers whose every sub-tool
    is denied are excluded.
    """
    builtin_perms = load_builtin_permissions()
    builtin_tools = [
        t for t in FULL_TOOLS
        if builtin_perms.get(t, "always_allow") != "deny"
    ]
    mcp_names = [
        f"mcp:{t.name}"
        for t in load_all_tools()
        if t.mcp_config
        and t.enabled
        and t.auth_status in ("configured", "connected")
        and not _is_fully_denied(t)
    ]
    return builtin_tools + mcp_names


async def build_mcp_servers(allowed_tools: list[str]) -> dict:
    """Build the mcp_servers dict for ClaudeAgentOptions from installed MCP tools."""
    mcp_servers: dict = {}
    all_tools = load_all_tools()
    mcp_tools = [t for t in all_tools if t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")]
    logger.info(f"[MCP-DEBUG] Building MCP servers. {len(mcp_tools)} MCP tools found, allowed_tools has {len(allowed_tools)} entries")

    for tool in mcp_tools:
        tool_ref = f"mcp:{tool.name}"
        if tool_ref not in allowed_tools and allowed_tools != get_all_tool_names():
            if not any(tool_ref == at for at in allowed_tools):
                logger.info(f"[MCP-DEBUG] SKIPPED {tool.name}: '{tool_ref}' not in allowed_tools")
                continue

        if _is_fully_denied(tool):
            logger.info(f"[MCP-DEBUG] SKIPPED {tool.name}: fully denied")
            continue

        if tool.auth_type == "oauth2" and tool.auth_status == "connected":
            refreshed = await refresh_google_token(tool)
            logger.info(f"[MCP-DEBUG] {tool.name} token refresh: {'OK' if refreshed else 'FAILED'}")

        config = derive_mcp_config(tool)
        if config:
            server_name = _sanitize_server_name(tool.name)
            mcp_servers[server_name] = config
            env_keys = list(config.get("env", {}).keys())
            logger.info(f"[MCP-DEBUG] ADDED {server_name}: command={config.get('command')}, args={config.get('args')}, env_keys={env_keys}")
        else:
            logger.warning(f"[MCP-DEBUG] {tool.name}: derive_mcp_config returned None")

    logger.info(f"[MCP-DEBUG] Final mcp_servers: {list(mcp_servers.keys())}")
    return mcp_servers


def get_effective_policy(
    tool_name: str,
    builtin_perms: dict[str, str],
) -> str:
    """Return 'always_allow', 'deny', or 'ask' for any tool."""
    if tool_name in builtin_perms:
        return builtin_perms[tool_name]

    bm = _re.match(r"mcp__openswarm-browser-agent__(.+)", tool_name)
    if bm:
        return builtin_perms.get(bm.group(1), "always_allow")

    im = _re.match(r"mcp__openswarm-invoke-agent__(.+)", tool_name)
    if im:
        return builtin_perms.get(im.group(1), "always_allow")

    m = _re.match(r"mcp__([^_]+(?:-[^_]+)*)__(.+)", tool_name)
    if m:
        server_slug, mcp_tool_name = m.group(1), m.group(2)
        for t in load_all_tools():
            if not t.mcp_config or not t.enabled:
                continue
            if _sanitize_server_name(t.name) == server_slug:
                return t.tool_permissions.get(mcp_tool_name, "ask")
    return "always_allow"
