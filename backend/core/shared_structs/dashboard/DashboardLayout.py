from pydantic import BaseModel, Field
from typing import Dict
from backend.core.shared_structs.browser.BrowserCardPosition import BrowserCardPosition
from backend.core.shared_structs.card.CardPosition import CardPosition

class DashboardLayout(BaseModel):
    cards: Dict[str, CardPosition] = Field(default_factory=dict)
    app_cards: Dict[str, CardPosition] = Field(default_factory=dict)
    browser_cards: Dict[str, BrowserCardPosition] = Field(default_factory=dict)
    expanded_card_ids: list[str] = Field(default_factory=list)