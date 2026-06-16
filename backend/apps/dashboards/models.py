from pydantic import BaseModel, ConfigDict, Field
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


class BrowserTab(BaseModel):
    id: str
    url: str = ""
    title: str = ""
    favicon: Optional[str] = None


class BrowserCardPosition(BaseModel):
    browser_id: str
    url: str = ""
    tabs: list[BrowserTab] = Field(default_factory=list)
    activeTabId: str = ""
    x: float = 0
    y: float = 0
    width: float = 1280
    height: float = 800
    # Agent session id that spawned this browser, or None for user-created.
    # Used by the frontend to auto-remove the browser when its owner agent
    # reaches a terminal completed/error state.
    spawned_by: Optional[str] = None
    # When the agent leaves the deliverable on the page (a video playing, a page
    # to read), it sets this so the frontend's auto-close on parent finish skips
    # the card and the browser stays put.
    keep_open: bool = False


class NotePosition(BaseModel):
    note_id: str
    x: float = 0
    y: float = 0
    width: float = 240
    height: float = 200
    content: str = ""
    color: str = "yellow"


class DashboardLayout(BaseModel):
    # extra="allow" so any keys the FE sends (or legacy on-disk layouts
    # carry) round-trip without Pydantic stripping them.
    model_config = ConfigDict(extra="allow")
    cards: dict[str, CardPosition] = Field(default_factory=dict)
    view_cards: dict[str, ViewCardPosition] = Field(default_factory=dict)
    browser_cards: dict[str, BrowserCardPosition] = Field(default_factory=dict)
    notes: dict[str, NotePosition] = Field(default_factory=dict)
    expanded_session_ids: list[str] = Field(default_factory=list)


class Dashboard(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str = "Untitled Dashboard"
    auto_named: bool = False
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
    layout: DashboardLayout = Field(default_factory=DashboardLayout)
    thumbnail: Optional[str] = None
    # Bumped only when a fresh thumbnail is saved; drives sidebar/grid order so merely opening a dashboard doesn't reshuffle the list.
    preview_updated_at: Optional[datetime] = None
    # Sorted card-id set captured with the last thumbnail; lets the client tell if cards were added/removed since.
    preview_signature: Optional[str] = None


class DashboardCreate(BaseModel):
    name: str = "Untitled Dashboard"


class DashboardUpdate(BaseModel):
    name: Optional[str] = None
    layout: Optional[DashboardLayout] = None
    thumbnail: Optional[str] = None
    preview_signature: Optional[str] = None
