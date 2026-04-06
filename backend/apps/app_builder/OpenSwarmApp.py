from pydantic import BaseModel, Field
from typing import Optional
from uuid import uuid4
from datetime import datetime


class OpenSwarmApp(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    description: str = ""
    icon: str = "view_quilt"
    files: dict[str, str] = Field(default_factory=dict)
    thumbnail: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now().isoformat())