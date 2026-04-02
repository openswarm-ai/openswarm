from ast import List
from typing import Literal, Optional
from pydantic import BaseModel


TOOL_PERMISSIONS = Literal["allow", "ask", "deny"]

class Tool(BaseModel):
    name: str
    description: Optional[str] = None
    deferred: bool
    permission: TOOL_PERMISSIONS

class Toolkit(BaseModel):
    name: str
    description: str
    tools: List[Tool]

