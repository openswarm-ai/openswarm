from typing import Optional
from pydantic import BaseModel
from backend.core.tools.shared_structs.TOOL_PERMISSIONS import TOOL_PERMISSIONS
from typeguard import typechecked

class Tool(BaseModel):
    name: str
    description: Optional[str] = None
    deferred: bool
    permission: TOOL_PERMISSIONS

    @typechecked
    def to_sdk_args(self) -> str:
        return self.name