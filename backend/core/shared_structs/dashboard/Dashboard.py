from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from backend.core.shared_structs.dashboard.DashboardLayout import DashboardLayout
from uuid import uuid4

class Dashboard(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str = "Untitled Dashboard"
    auto_named: bool = False
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
    layout: DashboardLayout = Field(default_factory=DashboardLayout)
    thumbnail: Optional[str] = None