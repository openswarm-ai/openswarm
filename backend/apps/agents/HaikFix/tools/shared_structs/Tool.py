from typing import Optional, Dict, Any, Literal, Callable, Awaitable, List, Union
from pydantic import BaseModel, Field
from backend.apps.agents.HaikFix.tools.shared_structs.TOOL_PERMISSIONS import TOOL_PERMISSIONS
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

class Tool(BaseModel):
    name: str
    description: Optional[str] = None
    deferred: bool
    permission: TOOL_PERMISSIONS

    @typechecked
    def to_sdk_args(self) -> str:
        return self.name