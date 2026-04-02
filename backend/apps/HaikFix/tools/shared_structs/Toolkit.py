from typing import Optional, List
from pydantic import BaseModel
from backend.apps.HaikFix.tools.shared_structs.Tool import Tool
from backend.apps.HaikFix.tools.shared_structs.TOOL_PERMISSIONS import TOOL_PERMISSIONS
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
        self.validate_structure(tools, nested_toolkits)

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