from pydantic import BaseModel, Field


class CardPosition(BaseModel):
    session_id: str
    x: float = 0
    y: float = 0
    width: float = 420
    height: float = 280


class ViewCardPosition(BaseModel):
    output_id: str
    # Which instance of the app this card is (1 = primary). Persisted or Pydantic strips it on save and a reloaded second-instance card collapses onto the primary's runtime (same failure shape as the browser-card dashboard_id bleed).
    instance: int = 1
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
