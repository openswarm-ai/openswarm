from pydantic import BaseModel, Field
from typing import Optional, List, Dict
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


class BrowserTab(BaseModel):
    id: str
    url: str = ""
    title: str = ""
    favicon: Optional[str] = None


class BrowserCardPosition(BaseModel):
    browser_id: str
    url: str = ""
    tabs: List[BrowserTab] = Field(default_factory=list)
    activeTabId: str = ""
    x: float = 0
    y: float = 0
    width: float = 1280
    height: float = 800


class DashboardLayout(BaseModel):
    cards: Dict[str, CardPosition] = Field(default_factory=dict)
    view_cards: Dict[str, ViewCardPosition] = Field(default_factory=dict)
    browser_cards: Dict[str, BrowserCardPosition] = Field(default_factory=dict)
    expanded_session_ids: list[str] = Field(default_factory=list)


class Dashboard(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str = "Untitled Dashboard"
    auto_named: bool = False
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
    layout: DashboardLayout = Field(default_factory=DashboardLayout)
    thumbnail: Optional[str] = None