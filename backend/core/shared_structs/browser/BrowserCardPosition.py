from pydantic import Field
from typing import List

from backend.core.shared_structs.browser.BrowserTab import BrowserTab
from backend.core.shared_structs.card.CardPosition import CardPosition

class BrowserCardPosition(CardPosition):
    url: str = ""
    tabs: List[BrowserTab] = Field(default_factory=list)
    activeTabId: str = ""