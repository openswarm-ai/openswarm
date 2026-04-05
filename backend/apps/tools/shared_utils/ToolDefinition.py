from typing_extensions import Dict
from pydantic import BaseModel, Field
from typing import Optional, Any
from uuid import uuid4
from backend.core.tools.shared_structs.TOOL_PERMISSIONS import TOOL_PERMISSIONS

# TODO: better type specing of this whole class, also we may not even need this class????
class ToolDefinition(BaseModel):
    model_config = {"extra": "ignore"}

    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    command: str = ""
    mcp_config: Dict[str, Any] = Field(default_factory=dict)
    credentials: Dict[str, str] = Field(default_factory=dict)
    auth_type: str = "none"
    auth_status: str = "none"
    oauth_provider: Optional[str] = None
    oauth_tokens: Dict[str, Any] = Field(default_factory=dict)
    tool_permissions: Dict[str, TOOL_PERMISSIONS] = Field(default_factory=dict)
    tool_descriptions: Dict[str, str] = Field(default_factory=dict) # tool_descriptions[tool_name] = tool_description
    connected_account_email: Optional[str] = None
    enabled: bool = True
