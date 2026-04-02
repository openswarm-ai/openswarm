from typing import Optional, Literal, Union, Dict
from pydantic import BaseModel

from typeguard import typechecked

########################################################
# Promp Chunk Types
########################################################

TextChunkDict = Dict[Literal["type", "text"], str]
class TextChunk(BaseModel):
    type: str = "text"
    text: str

    @typechecked
    def __init__(self, text: str) -> None:
        self.text = text

    @typechecked
    def to_dict(self) -> TextChunkDict:
        return {
            "type": self.type,
            "text": self.text,
        }


ImageChunkDict = Dict[Literal["type", "data", "media_type"], str]
class ImageChunk(BaseModel):
    type: str = "base64"
    data: str
    media_type: str

    @typechecked
    def __init__(self, data: str, media_type: str) -> None:
        self.data = data
        self.media_type = media_type

    @typechecked
    def to_dict(self) -> ImageChunkDict:
        return {
            "type": self.type,
            "data": self.data,
            "media_type": self.media_type,
        }




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
# NOTE: is a string, tool call, or tool result


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