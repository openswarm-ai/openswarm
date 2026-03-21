from pydantic import BaseModel, Field
from typing import Optional, Any

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
    theme: str = "dark"
    new_agent_shortcut: str = "Meta+l"
    anthropic_api_key: Optional[str] = None
    browser_homepage: str = "https://www.google.com"
    # Telephony / Channel credentials
    twilio_account_sid: Optional[str] = None
    twilio_auth_token: Optional[str] = None
    telnyx_api_key: Optional[str] = None
    elevenlabs_api_key: Optional[str] = None
    deepgram_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    google_api_key: Optional[str] = None
    openrouter_api_key: Optional[str] = None
    custom_providers: list["CustomProvider"] = Field(default_factory=list)
    webhook_base_url: Optional[str] = None
    # Dashboard / UI preferences
    auto_select_mode_on_new_agent: bool = False
    expand_new_chats_in_dashboard: bool = False
    auto_reveal_sub_agents: bool = True
    dev_mode: bool = False
    # Analytics: opted in by default, user can toggle off
    analytics_opt_in: bool = True
    installation_id: Optional[str] = None


class CustomProvider(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    models: list[dict[str, Any]] = Field(default_factory=list)
