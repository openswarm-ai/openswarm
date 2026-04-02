from pydantic import BaseModel, Field
from typing import Optional, Any

DEFAULT_SYSTEM_PROMPT = (
    "You are a personal AI assistant running inside OpenSwarm.\n\n"
    "## Tool Priority\n"
    "When a dedicated MCP tool exists for a task, use it directly — do not use the browser for things MCP tools can handle.\n"
    "Priority order:\n"
    "1. MCP tools first (Reddit, Google Workspace, Twitter, etc.) — fastest and most reliable\n"
    "2. WebSearch / WebFetch — for general web lookups without a dedicated MCP\n"
    "3. BrowserAgent — only when you need to visually interact with a website, fill forms, or do something no other tool can handle\n\n"
    "## Tool Call Style\n"
    "Default: do not narrate routine tool calls — just call the tool.\n"
    "Narrate only when it helps: multi-step work, complex problems, or when the user explicitly asks.\n"
    "Keep narration brief. Use plain language.\n\n"
    "## Interaction Style\n"
    "Be direct and action-oriented. Do not ask clarifying questions unless genuinely ambiguous — "
    "make reasonable assumptions and act. If you need to ask, use the AskUserQuestion tool.\n"
    "Do not over-explain what you are about to do. Just do it and show the results.\n"
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
    # Multi-provider API keys
    openai_api_key: Optional[str] = None
    google_api_key: Optional[str] = None
    openrouter_api_key: Optional[str] = None
    custom_providers: list["CustomProvider"] = Field(default_factory=list)
    # Dashboard / UI preferences
    auto_select_mode_on_new_agent: bool = False
    expand_new_chats_in_dashboard: bool = False
    auto_reveal_sub_agents: bool = True
    dev_mode: bool = False
    # Subscription tokens (from CLI tools — alternative to API keys)
    claude_subscription_token: Optional[str] = None
    openai_subscription_token: Optional[str] = None
    gemini_subscription_token: Optional[str] = None
    # GitHub Copilot
    copilot_github_token: Optional[str] = None
    copilot_token: Optional[str] = None
    copilot_token_expires: Optional[float] = None
    # User profile (collected during onboarding)
    user_name: Optional[str] = None
    user_email: Optional[str] = None
    user_use_case: Optional[str] = None
    # Analytics: opted in by default, user can toggle off
    analytics_opt_in: bool = True
    installation_id: Optional[str] = None
    first_opened_at: Optional[str] = None  # ISO timestamp of first app open


class CustomProvider(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    models: list[dict[str, Any]] = Field(default_factory=list)
