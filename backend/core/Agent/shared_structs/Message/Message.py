# Message.py

from typing import List, Literal, Dict, Annotated, Union
from pydantic import BaseModel, Field
from datetime import datetime
from uuid import uuid4
from typeguard import typechecked

from backend.core.Agent.shared_structs.Message.agent_inputs import (
    PromptBlock, TextPromptBlock, ImagePromptBlock, ImageSource, ContextPath, SkillMeta
)
from backend.core.Agent.shared_structs.Message.agent_outputs import (
    ToolCallContent, ToolResultContent
)

class Message(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    timestamp: datetime = Field(default_factory=datetime.now)
    branch_id: str = "main"
    hidden: bool = False


PromptMsgDict = Dict[
    Literal["type", "message"], 
    Dict[
        Literal["role", "content"], 
        List[PromptBlock]
        ]
    ]

class UserMessage(Message):
    role: Literal["user"] = "user"
    content: str
    images: List[str] = Field(default_factory=list)       # base64 strings
    image_media_types: List[str] = Field(default_factory=list)
    context_paths: List[ContextPath] = Field(default_factory=list)
    attached_skills: List[SkillMeta] = Field(default_factory=list)
    forced_tools: List[str] = Field(default_factory=list)

    @typechecked
    def to_prompt(self) -> PromptMsgDict:
        blocks: List[PromptBlock] = [TextPromptBlock(type="text", text=self.content)]
        for data, media_type in zip[tuple[str, str]](self.images, self.image_media_types):
            blocks.append(ImagePromptBlock(
                type="image",
                source=ImageSource(type="base64", media_type=media_type, data=data),
            ))
        return {
            "type": self.role, 
            "message": {
                "role": self.role, 
                "content": blocks
            }
        }

class AssistantMessage(Message):
    role: Literal["assistant"] = "assistant"
    content: str


class ToolCallMessage(Message):
    role: Literal["tool_call"] = "tool_call"
    content: ToolCallContent


class ToolResultMessage(Message):
    role: Literal["tool_result"] = "tool_result"
    content: ToolResultContent


class SystemMessage(Message):
    role: Literal["system"] = "system"
    content: str

AnyMessage = Annotated[
    Union[UserMessage, AssistantMessage, ToolCallMessage, ToolResultMessage, SystemMessage],
    Field(discriminator="role"),
]