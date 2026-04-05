from typing import Any
from backend.apps.tools.discover_tools.DiscoveryError import DiscoveryError, DiscoveryConfigError
from backend.apps.tools.discover_tools.utils.discover_mcp_tools_stdio import discover_mcp_tools_stdio
from backend.apps.tools.discover_tools.utils.discover_mcp_tools_http import discover_mcp_tools_http
from backend.apps.tools.discover_tools.utils.discover_mcp_tools_sse import discover_mcp_tools_sse
from typeguard import typechecked

# TODO: better type specing of this whole func
@typechecked
async def discover_tools(config: dict[str, Any], tool_name: str = "") -> list[dict]:
    """Probe an MCP server using the appropriate transport and return discovered tools.

    config is the raw mcp_config dict from a ToolDefinition (with credentials
    already injected by the converter if needed).

    Returns a list of dicts with keys: name, description, inputSchema.
    """
    transport = config.get("type", "")

    if transport == "stdio":
        command = config.get("command", "")
        if not command:
            raise DiscoveryConfigError("stdio transport requires a 'command' in MCP config")
        return await discover_mcp_tools_stdio(
            command=command,
            args=config.get("args"),
            env=config.get("env"),
        )

    if transport in ("http", "sse") or config.get("url"):
        url = config.get("url", "")
        if not url:
            raise DiscoveryConfigError("HTTP/SSE transport requires a 'url' in MCP config")
        if transport == "sse":
            return await discover_mcp_tools_sse(url, config.get("headers"))
        try:
            return await discover_mcp_tools_http(url, config.get("headers"))
        except DiscoveryError:
            print(f"[discover_tools] Streamable HTTP failed for {tool_name}, retrying with SSE")
            return await discover_mcp_tools_sse(url, config.get("headers"))

    raise DiscoveryConfigError(f"Unsupported MCP transport type: '{transport}'")
