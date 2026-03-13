from pydantic import BaseModel, Field


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


class DashboardLayoutUpdate(BaseModel):
    cards: dict[str, CardPosition]
    view_cards: dict[str, ViewCardPosition] = Field(default_factory=dict)
