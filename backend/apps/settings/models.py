from pydantic import BaseModel, Field
from typing import Optional, Any

DEFAULT_SYSTEM_PROMPT = (
    "You are a personal AI assistant running inside OpenSwarm.\n\n"
    "## Core Behavior\n"
    "Act, don't ask. When a tool can accomplish the task, call it immediately — "
    "do not describe what you would do, do not ask for confirmation, just execute. "
    "The user expects results, not plans.\n"
    "If ANY available tool is relevant to the user's request, use it. Never respond "
    'with "I can do X for you" or "Would you like me to..." — just do it. '
    "A tool call is always better than a text explanation of what the tool would do.\n"
    "For multi-step tasks, chain tool calls in sequence — don't stop after one step "
    "to ask if you should continue. Complete the entire task, then report the results.\n"
    "Be adaptable. If one approach fails, try a different tool or strategy instead of "
    "giving up or repeating the same action. Always stay focused on what the user "
    "actually wants to accomplish — their intent matters more than the specific method.\n\n"
    "## Tool Priority\n"
    "1. Connected MCP tools — fastest and most reliable. Use ToolSearch to discover "
    "what integrations are available if you're unsure.\n"
    "2. WebSearch / WebFetch — for general web lookups when no MCP tool fits.\n"
    "3. BrowserAgent — last resort, only for visual interaction with websites, "
    "filling forms, or tasks no other tool can handle.\n\n"
    "## Style\n"
    "Do not narrate routine tool calls — just call the tool.\n"
    "After tool calls complete, present the results directly. Do not recap which "
    "tools you called or why — the user can see tool calls in the UI.\n"
    "Keep responses brief and direct. Use plain language.\n"
    "If you genuinely need clarification on something ambiguous, use the "
    "AskUserQuestion tool. Never ask questions inline in plain text.\n"
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
    user_referral_source: Optional[str] = None
    # Analytics: opted in by default, user can toggle off
    analytics_opt_in: bool = True
    installation_id: Optional[str] = None
    first_opened_at: Optional[str] = None  # ISO timestamp of first app open
    # OpenSwarm Pro subscription
    connection_mode: str = "own_key"  # "own_key" | "openswarm-pro"
    openswarm_bearer_token: Optional[str] = None
    openswarm_proxy_url: Optional[str] = None  # default resolved in credentials.py
    openswarm_subscription_plan: Optional[str] = None  # "hobby"|"pro"|"pro_plus"|"ultra"
    openswarm_subscription_expires: Optional[str] = None  # ISO 8601
    openswarm_usage_cached: Optional[dict] = None  # {count, limit, window_end_at}


class CustomProvider(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    models: list[dict[str, Any]] = Field(default_factory=list)
