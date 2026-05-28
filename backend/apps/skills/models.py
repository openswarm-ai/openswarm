from pydantic import BaseModel, Field
from typing import Any, Optional
from uuid import uuid4


class Skill(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    content: str
    file_path: str = ""
    command: str = ""
    # Platform-shipped skills (e.g. App Builder): UI hides delete and DELETE returns 409, but content stays editable so users can tune them.
    built_in: bool = False


class SkillCreate(BaseModel):
    name: str
    description: str = ""
    content: str
    command: str = ""


class SkillUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    content: Optional[str] = None
    command: Optional[str] = None


class SkillWorkspaceSeedRequest(BaseModel):
    workspace_id: str
    skill_content: Optional[str] = None
    meta: Optional[dict[str, Any]] = None
