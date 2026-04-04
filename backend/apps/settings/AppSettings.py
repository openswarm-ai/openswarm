from backend.apps.settings.DEFAULT_SYSTEM_PROMPT import DEFAULT_SYSTEM_PROMPT
from pydantic import BaseModel
from typing import Optional

class AppSettings(BaseModel):
    # Agent settings
    default_system_prompt: str = DEFAULT_SYSTEM_PROMPT
    default_folder: Optional[str] = None
    default_model: str = "sonnet"
    default_mode: str = "agent"
    default_max_turns: Optional[int] = None
    anthropic_api_key: Optional[str] = None

    # Dashboard / UI preferences
    zoom_sensitivity: float = 50.0
    theme: str = "dark"
    new_agent_shortcut: str = "Meta+l"
    browser_homepage: str = "https://www.google.com"
    auto_select_mode_on_new_agent: bool = False
    expand_new_chats_in_dashboard: bool = True
    auto_reveal_sub_agents: bool = True
    dev_mode: bool = False