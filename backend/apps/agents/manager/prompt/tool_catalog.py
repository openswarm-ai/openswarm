import logging
from typing import List, Optional, Set

from typeguard import typechecked

from backend.apps.tools_lib.models import ToolDefinition
from backend.apps.tools_lib.tools_lib import (
    load_all_tools as load_all_tools,
    sanitize_server_name as sanitize_server_name,
    load_builtin_permissions,
)

logger = logging.getLogger(__name__)

FULL_TOOLS = [
    "Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion",
    "WebSearch", "WebFetch", "NotebookEdit", "TodoWrite",
    "EnterPlanMode", "ExitPlanMode", "EnterWorktree",
    "TaskOutput", "TaskStop",
    "CronCreate", "CronList", "CronDelete",
    "InvokeAgent",
    "Agent",
    # ToolSearch is the loader the CLI uses to expose deferred tool schemas on demand. Must be in the allowedTools whitelist or the model can't call it, which means none of the deferred extended tools become reachable even when the CLI advertises them in the system prompt.
    "ToolSearch",
]


@typechecked
def get_denied_tool_names(tool: ToolDefinition) -> Set[str]:
    """Return the set of MCP sub-tool names whose permission is 'deny'."""
    return {
        key for key, value in tool.tool_permissions.items()
        if not key.startswith("_") and value == "deny"
    }


@typechecked
def get_all_known_tool_names(tool: ToolDefinition) -> Set[str]:
    """Return all known sub-tool names for an MCP tool (from _tool_descriptions)."""
    return set(tool.tool_permissions.get("_tool_descriptions", {}).keys())


@typechecked
def is_fully_denied(tool: ToolDefinition) -> bool:
    """True when every known sub-tool on this MCP server is set to 'deny'."""
    known = get_all_known_tool_names(tool)
    if not known:
        return False
    return known <= get_denied_tool_names(tool)


@typechecked
def get_all_tool_names() -> List[str]:
    """FULL_TOOLS + installed MCP tool identifiers (mcp:<tool_name>).

    Builtin tools set to 'deny' and MCP servers whose every sub-tool
    is denied are excluded."""
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
        and not is_fully_denied(t)
    ]
    return builtin_tools + mcp_names


@typechecked
def gated_mcp_server_names(allowed_tools: List[str], active_mcps: Optional[List[str]]) -> List[str]:
    """Names of installed MCP servers withheld from the SDK because they're
    not activated yet, exactly the servers the model sees in the
    <mcp_servers> block but can't reach via ToolSearch. The only way in is
    MCPActivate; used to steer a model looping on ToolSearch to the gate."""
    active_set = set(active_mcps or [])
    names: List[str] = []
    try:
        for tool in load_all_tools():
            if not (tool.mcp_config and tool.enabled and tool.auth_status in ("configured", "connected")):
                continue
            tool_ref = f"mcp:{tool.name}"
            if tool_ref not in allowed_tools and allowed_tools != get_all_tool_names():
                continue
            if is_fully_denied(tool):
                continue
            server_name = sanitize_server_name(tool.name)
            if server_name not in active_set:
                names.append(server_name)
    except Exception:
        logger.exception("gated MCP server enumeration failed")
    return names
