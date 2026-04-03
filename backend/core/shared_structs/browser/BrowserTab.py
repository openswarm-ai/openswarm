from pydantic import BaseModel
from typing import Optional

class BrowserTab(BaseModel):
    id: str
    url: str = ""
    title: str = ""
    favicon: Optional[str] = None   