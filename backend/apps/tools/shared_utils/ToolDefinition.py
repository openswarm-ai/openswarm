from pydantic import BaseModel, Field
from typing import Optional, Any
from uuid import uuid4
from backend.core.tools.shared_structs.TOOL_PERMISSIONS import TOOL_PERMISSIONS


class ToolDefinition(BaseModel):
    model_config = {"extra": "ignore"}

    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    command: str = ""
    mcp_config: dict[str, Any] = Field(default_factory=dict)
    credentials: dict[str, str] = Field(default_factory=dict)
    auth_type: str = "none"
    auth_status: str = "none"
    oauth_provider: Optional[str] = None
    oauth_tokens: dict[str, Any] = Field(default_factory=dict)
    tool_permissions: dict[str, TOOL_PERMISSIONS] = Field(default_factory=dict)
    tool_descriptions: dict[str, str] = Field(default_factory=dict) # tool_descriptions[tool_name] = tool_description
    connected_account_email: Optional[str] = None
    enabled: bool = True
