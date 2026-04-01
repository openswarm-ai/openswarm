from typing import Dict, Literal
from pydantic import BaseModel
from typeguard import typechecked

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