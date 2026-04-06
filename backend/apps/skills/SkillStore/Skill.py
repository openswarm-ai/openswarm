from pydantic import BaseModel, Field
from typing import Optional
from uuid import uuid4


class Skill(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    content: str = ""
    file_path: str = ""
    command: str = ""
