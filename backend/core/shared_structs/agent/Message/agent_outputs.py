from typing import Dict, Any, TypedDict, List
from typing_extensions import NotRequired
from pydantic import BaseModel


# --- Stored content types ---
class ToolCallContent(BaseModel):
    id: str
    tool: str
    input: Dict[str, Any]

class ToolResultContent(BaseModel):
    tool_use_id: str
    text: str
    is_error: bool = False


# --- Tool response types ---

class TextContent(TypedDict):
    type: str
    text: str

class ToolResponse(TypedDict):
    content: List[TextContent]
    is_error: NotRequired[bool]