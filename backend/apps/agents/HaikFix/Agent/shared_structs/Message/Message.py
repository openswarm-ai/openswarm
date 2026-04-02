from typing import Optional, Literal, Union, List, Dict
from pydantic import BaseModel, Field
from datetime import datetime
from uuid import uuid4

from backend.apps.agents.HaikFix.Agent.shared_structs.Message.sub_types import  (
    MessageContent, ContextPath, SkillMeta, ImageChunkDict, TextChunkDict, TextChunk, ImageChunk
)
from typeguard import typechecked

PromptMsgDict = Dict[
    Literal["type", "message"], 
    Dict[
        Literal["role", "content"], 
        List[
            Union[ImageChunkDict, TextChunkDict]
            ]
        ]
    ]

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
    images: Optional[List[ImageChunk]] = None
    hidden: bool = False

    @typechecked
    def to_prompt(self) -> PromptMsgDict:
        assert isinstance(self.content, str), "Content must be a string"
        prompt: str = self.content
        content: List[Union[ImageChunkDict, TextChunkDict]] = [TextChunk(text=prompt).to_dict()]
        for img in self.images:
            content.append(img.to_dict())
        return {
            "type": "user", 
            "message": {
                "role": "user", 
                "content": content
            }
        }
