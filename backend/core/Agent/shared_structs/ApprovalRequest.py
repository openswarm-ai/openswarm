from pydantic import BaseModel, Field
from typing import Any
from datetime import datetime
from uuid import uuid4

class ApprovalRequest(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    session_id: str
    tool_name: str
    tool_input: dict[str, Any]
    created_at: datetime = Field(default_factory=datetime.now)
