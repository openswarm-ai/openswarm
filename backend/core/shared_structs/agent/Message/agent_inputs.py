# sub_types.py

from typing import Literal, Union, TypedDict
from pydantic import BaseModel


# --- Prompt content blocks (sent to SDK via to_prompt) ---

class TextPromptBlock(TypedDict):
    type: Literal["text"]
    text: str

class ImageSource(TypedDict):
    type: Literal["base64"]
    media_type: str
    data: str

class ImagePromptBlock(TypedDict):
    type: Literal["image"]
    source: "ImageSource"


PromptBlock = Union[TextPromptBlock, ImagePromptBlock]

# --- Attachments (user message only) ---

class ContextPath(BaseModel):
    path: str
    type: Literal["file", "directory"]

class SkillMeta(BaseModel):
    id: str
    name: str
    content: str = ""