from pydantic import BaseModel, Field
from typing import Optional, Literal, Union, List, Dict
from datetime import datetime
from uuid import uuid4


########################################################
# Message Content Types
########################################################

class ToolCallContent(BaseModel):
    id: str
    tool: str
    input: dict

class ToolResultContent(BaseModel):
    text: str
    tool_name: Optional[str] = None
    elapsed_ms: Optional[float] = None
    sub_session_id: Optional[str] = None

MessageContent = Union[str, ToolCallContent, ToolResultContent]


########################################################
# Additional Message Types
########################################################

class ContextPath(BaseModel):
    path: str
    type: Literal["file", "directory"]

class SkillMeta(BaseModel):
    id: str
    name: str
    # NOTE: content is omitted in backend to save space

class ImageMeta(BaseModel):
    data: str  # base64-encoded
    media_type: str = "image/png"

class Message(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    role: Literal["user", "assistant", "tool_call", "tool_result", "system"]
    content: MessageContent
    timestamp: datetime = Field(default_factory=datetime.now)
    branch_id: str = "main"
    parent_id: Optional[str] = None
    context_paths: Optional[List[ContextPath]] = None
    attached_skills: Optional[List[SkillMeta]] = None
    forced_tools: Optional[List[str]] = None
    images: Optional[List[ImageMeta]] = None
    hidden: bool = False
