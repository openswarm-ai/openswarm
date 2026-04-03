from typing import Optional, List, Dict, Tuple
from pydantic import BaseModel
from backend.core.tools.shared_structs.Tool import Tool
from backend.core.tools.shared_structs.TOOL_PERMISSIONS import TOOL_PERMISSIONS
from backend.core.tools.shared_structs.MCP_Tool import MCP_Tool
from claude_agent_sdk.types import McpServerConfig
from typeguard import typechecked

class Toolkit(BaseModel):
    name: str
    description: str
    tools: Optional[List[Tool]] = None
    nested_toolkits: Optional[List["Toolkit"]] = None

    @typechecked
    def __init__(
        self, 
        name: str, 
        description: str, 
        tools: Optional[List[Tool]] = None, 
        nested_toolkits: Optional[List["Toolkit"]] = None
    ) -> None:
        super().__init__(
            name=name, 
            description=description, 
            tools=tools, 
            nested_toolkits=nested_toolkits
        )
        self.validate_structure()

    @typechecked
    def validate_structure(self) -> None:
        assert not ( (self.tools is None) and (self.nested_toolkits is None) ), "Either tools or nested_toolkits must be provided"
        assert (self.tools is None) or (self.nested_toolkits is None), "Only one of tools or nested_toolkits can be provided"

    @typechecked
    def set_permission(self, permission: TOOL_PERMISSIONS) -> None:
        self.validate_structure()
        if self.tools is not None:
            for tool in self.tools:
                tool.permission = permission
        if self.nested_toolkits is not None:
            for toolkit in self.nested_toolkits:
                toolkit.set_permission(permission)

    @typechecked
    def collect_mcp_servers(self) -> Dict[str, McpServerConfig]:
        """Walk the toolkit tree and collect MCP server configs from every MCP_Tool.

        Returns a dict mapping server_name -> McpServerConfig, ready to pass
        to ClaudeAgentOptions(mcp_servers=...).
        """
        servers: Dict[str, McpServerConfig] = {}
        if self.tools is not None:
            for tool in self.tools:
                if isinstance(tool, MCP_Tool):
                    tool_config: Dict[str, McpServerConfig] = tool.to_mcp_server_config()
                    for key, value in tool_config.items():
                        servers[key] = value
        if self.nested_toolkits is not None:
            for toolkit in self.nested_toolkits:
                toolkit_config: Dict[str, McpServerConfig] = toolkit.collect_mcp_servers()
                for key, value in toolkit_config.items():
                    servers[key] = value
        return servers

    @typechecked
    def collect_tool_permissions(self) -> Tuple[List[str], List[str]]:
        """Walk the toolkit tree and partition tools by permission.

        Returns (allowed_tools, disallowed_tools) — lists of SDK-format
        tool names.  Tools with permission "ask" appear in neither list;
        they are gated at runtime by the can_use_tool hook.
        """
        allowed: List[str] = []
        disallowed: List[str] = []
        if self.tools is not None:
            for tool in self.tools:
                sdk_name: str = tool.to_sdk_args()
                if tool.permission == "allow":
                    allowed.append(sdk_name)
                elif tool.permission == "deny":
                    disallowed.append(sdk_name)
        if self.nested_toolkits is not None:
            for toolkit in self.nested_toolkits:
                a: List[str]
                d: List[str]
                a, d = toolkit.collect_tool_permissions()
                allowed.extend(a)
                disallowed.extend(d)
        return allowed, disallowed

    @typechecked
    def resolve_permission(self, sdk_name: str) -> Optional[TOOL_PERMISSIONS]:
        """Look up the permission for a single tool by its SDK-format name.

        Returns the tool's permission if found, or None if the tool
        doesn't exist in this toolkit tree.
        """
        if self.tools is not None:
            for tool in self.tools:
                if tool.to_sdk_args() == sdk_name:
                    return tool.permission
        if self.nested_toolkits is not None:
            for toolkit in self.nested_toolkits:
                found: Optional[TOOL_PERMISSIONS] = toolkit.resolve_permission(sdk_name)
                if found is not None:
                    return found
        return None