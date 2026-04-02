from typing import Optional, Dict, Any, Literal, Callable, Awaitable, List, Union
from pydantic import Field
from claude_agent_sdk import (
    create_sdk_mcp_server, 
    tool as sdk_tool
)
from claude_agent_sdk.types import (
    McpStdioServerConfig,
    McpSSEServerConfig,
    McpHttpServerConfig,
    McpSdkServerConfig,
    McpServerConfig
)
from typeguard import typechecked
from backend.apps.HaikFix.tools.shared_structs.Tool import Tool

class MCP_Tool(Tool):
    server_name: str
    input_schema: type

    @typechecked
    def to_sdk_args(self) -> str:
        return f"mcp__{self.server_name}__{self.name}"

    @typechecked
    def to_mcp_server_config(self) -> Dict[str, McpServerConfig]:
        raise NotImplementedError("Subclasses must implement this method")


class SDK_MCP_Tool(MCP_Tool):
    # sdk transport: in-process handler
    handler: Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]]

    @typechecked
    def to_mcp_server_config(self) -> Dict[str, McpSdkServerConfig]:

        @sdk_tool(self.name, self.description or "", self.input_schema)
        async def sdk_handler(args):
            return await self.handler(args)
        
        server: McpSdkServerConfig = create_sdk_mcp_server(self.server_name, tools=[sdk_handler])

        return {self.server_name: server}


class STDIO_MCP_Tool(MCP_Tool):
    command: Optional[str] = None
    args: List[str] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict)

    @typechecked
    def to_mcp_server_config(self) -> Dict[str, McpStdioServerConfig]:
        return {self.server_name: {
            "type": "stdio",
            "command": self.command,
            "args": self.args,
            "env": self.env,
        }}


class SSE_HTTP_MCP_Tool(MCP_Tool):
    transport: Literal["sse", "http"]
    url: Optional[str] = None
    headers: Dict[str, str] = Field(default_factory=dict)

    @typechecked
    def to_mcp_server_config(self) -> Dict[str, Union[McpSSEServerConfig, McpHttpServerConfig]]:
        return {self.server_name: {
            "type": self.transport,
            "url": self.url,
            "headers": self.headers,
        }}