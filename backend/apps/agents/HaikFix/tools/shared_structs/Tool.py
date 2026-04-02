from typing import Optional
from pydantic import BaseModel
from backend.apps.agents.HaikFix.tools.shared_structs.TOOL_PERMISSIONS import TOOL_PERMISSIONS

class Tool(BaseModel):
    name: str
    description: Optional[str] = None
    deferred: bool
    permission: TOOL_PERMISSIONS