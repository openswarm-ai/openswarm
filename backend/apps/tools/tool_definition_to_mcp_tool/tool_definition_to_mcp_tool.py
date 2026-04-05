"""Convert a persisted ToolDefinition into a typed MCP_Tool for the Toolkit tree.

Replaces the legacy derive_mcp_config() — instead of producing raw dicts,
we produce STDIO_MCP_Tool or SSE_HTTP_MCP_Tool instances that slot directly
into the Toolkit and participate in collect_mcp_servers / collect_tool_permissions.
"""

from typing import Optional

from backend.apps.tools.shared_utils.ToolDefinition import ToolDefinition
from backend.core.tools.shared_structs.MCP_Tool import MCP_Tool
from backend.apps.tools.tool_definition_to_mcp_tool.helpers.inject_credentials import inject_credentials
from backend.apps.tools.tool_definition_to_mcp_tool.helpers.build_stdio_tool import build_stdio_tool
from backend.apps.tools.tool_definition_to_mcp_tool.helpers.build_http_sse_tool import build_http_sse_tool
from typeguard import typechecked
import re


P_SANITIZE_RE: re.Pattern[str] = re.compile(r"[^a-zA-Z0-9\-]")

@typechecked
def p_sanitize_mcp_server_name(name: str) -> str:
    return P_SANITIZE_RE.sub("-", name).strip("-").lower()


# TODO: better type specing of this whole func
@typechecked
def tool_definition_to_mcp_tool(
    tool_def: ToolDefinition,
    oauth_providers: Optional[dict] = None,
) -> Optional[MCP_Tool]:
    """Build an MCP_Tool from a ToolDefinition, or None if config is missing.

    oauth_providers is the OAUTH_PROVIDERS dict from the oauth module,
    passed in to avoid a circular import.
    """
    if not tool_def.mcp_config:
        return None

    config: dict = dict(tool_def.mcp_config)
    transport = config.get("type", "")
    server_name = p_sanitize_mcp_server_name(tool_def.name)

    inject_credentials(tool_def, config, oauth_providers)

    if transport == "stdio":
        return build_stdio_tool(tool_def, config, server_name)
    elif transport in ("http", "sse"):
        return build_http_sse_tool(tool_def, config, server_name, transport)

    print(f"[tool_definition_to_mcp_tool] Unsupported MCP transport type '{transport}' for tool {tool_def.name}")
    return None
