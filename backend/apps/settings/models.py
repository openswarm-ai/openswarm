from pydantic import BaseModel
from typing import Optional


class AppSettings(BaseModel):
    default_system_prompt: Optional[str] = None
    default_folder: Optional[str] = None
    default_model: str = "sonnet"
    default_mode: str = "agent"
    default_max_turns: Optional[int] = None
    zoom_sensitivity: float = 50.0
    theme: str = "dark"
    new_agent_shortcut: str = "Meta+l"
    anthropic_api_key: Optional[str] = None
    browser_homepage: str = "https://www.google.com"
