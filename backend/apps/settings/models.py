from pydantic import BaseModel
from typing import Optional

DEFAULT_SYSTEM_PROMPT = (
    '"Ask the user as many follow ups as needed in order to eliminate any possible ambiguity. '
    "When asking the user questions, use the AskUserQuestion tool.\n\n"
    "You are an unstopable Agent that does whatever is needed to achieve the task. "
    "You are particularly gifted at coding, so when needed, transpose ordinary tasks into coding tasks.\n\n"
    'If a Browser is selected, prioritize this over other tools when it makes sense (so the user also has observability)."'
)


class AppSettings(BaseModel):
    default_system_prompt: Optional[str] = DEFAULT_SYSTEM_PROMPT
    default_folder: Optional[str] = None
    default_model: str = "sonnet"
    default_mode: str = "agent"
    default_max_turns: Optional[int] = None
    zoom_sensitivity: float = 50.0
    theme: str = "midnight"  # midnight | obsidian | vapor | aurora | light | sand
    radius_scale: float = 1.0  # multiplier applied to all theme radius tokens (0.0 = sharp, 2.0 = very round)
    new_agent_shortcut: str = "Meta+l"
    anthropic_api_key: Optional[str] = None
    browser_homepage: str = "https://www.google.com"
    auto_select_mode_on_new_agent: bool = False
    expand_new_chats_in_dashboard: bool = False
    auto_reveal_sub_agents: bool = True
    dev_mode: bool = False
