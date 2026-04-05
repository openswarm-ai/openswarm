from pydantic import BaseModel, Field
from typing import Optional
from uuid import uuid4


class Mode(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    system_prompt: Optional[str] = None
    tools: Optional[list[str]] = None
    default_next_mode: Optional[str] = None
    is_builtin: bool = False
    icon: str = "smart_toy"
    color: str = "#818cf8"
    default_folder: Optional[str] = None