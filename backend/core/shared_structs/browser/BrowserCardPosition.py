from pydantic import BaseModel, Field
from typing import List

from backend.core.shared_structs.browser.BrowserTab import BrowserTab

class BrowserCardPosition(BaseModel):
    browser_id: str
    url: str = ""
    tabs: List[BrowserTab] = Field(default_factory=list)
    activeTabId: str = ""
    x: float = 0
    y: float = 0
    width: float = 1280
    height: float = 800
