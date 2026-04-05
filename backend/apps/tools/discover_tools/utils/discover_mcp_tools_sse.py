from mcp.client.sse import sse_client
from mcp import ClientSession
from mcp.types import Implementation
from exceptiongroup import BaseExceptionGroup

from backend.apps.tools.discover_tools.DiscoveryError import DiscoveryError
from typeguard import typechecked

@typechecked
async def discover_mcp_tools_sse(url: str, headers: dict | None = None) -> list[dict]:
    """Discover tools via SSE transport using the mcp SDK client."""
    try:
        async with sse_client(url=url, headers=headers, timeout=30, sse_read_timeout=30) as (read_stream, write_stream):
            async with ClientSession(
                read_stream, write_stream,
                client_info=Implementation(name="openswarm", version="0.1.0"),
            ) as session:
                await session.initialize()
                result = await session.list_tools()
                return [
                    {"name": t.name, "description": t.description or "", "inputSchema": t.inputSchema if t.inputSchema else None}
                    for t in result.tools
                ]
    except BaseExceptionGroup as eg:
        first = eg.exceptions[0] if eg.exceptions else eg
        raise DiscoveryError(f"SSE discovery failed: {first}") from first