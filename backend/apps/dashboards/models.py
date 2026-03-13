from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from uuid import uuid4


class CardPosition(BaseModel):
    session_id: str
    x: float = 0
    y: float = 0
    width: float = 420
    height: float = 280


class ViewCardPosition(BaseModel):
    output_id: str
    x: float = 0
    y: float = 0
    width: float = 480
    height: float = 360


class DashboardLayout(BaseModel):
    cards: dict[str, CardPosition] = Field(default_factory=dict)
    view_cards: dict[str, ViewCardPosition] = Field(default_factory=dict)


class Dashboard(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str = "Untitled Dashboard"
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
    layout: DashboardLayout = Field(default_factory=DashboardLayout)


class DashboardCreate(BaseModel):
    name: str = "Untitled Dashboard"


class DashboardUpdate(BaseModel):
    name: Optional[str] = None
    layout: Optional[DashboardLayout] = None
