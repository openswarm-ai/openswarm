from backend.apps.tools.shared_utils.ToolDefinition import ToolDefinition
from backend.core.tools.shared_structs.MCP_Tool import SSE_HTTP_MCP_Tool
from typeguard import typechecked

# TODO: better type specing of this whole func
@typechecked
def build_http_sse_tool(
    tool_def: ToolDefinition,
    config: dict,
    server_name: str,
    transport: str,
) -> SSE_HTTP_MCP_Tool:
    return SSE_HTTP_MCP_Tool(
        name=tool_def.name,
        description=tool_def.description,
        deferred=False,
        permission="ask",
        server_name=server_name,
        transport=transport,  # type: ignore[arg-type]
        url=config.get("url"),
        headers=config.get("headers", {}),
    )
