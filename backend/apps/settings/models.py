from pydantic import BaseModel, Field
from typing import Optional, Any, Literal

DEFAULT_SYSTEM_PROMPT = (
    "You are a personal AI assistant running inside OpenSwarm.\n\n"
    "## Core Behavior\n"
    "Act, don't ask. When a tool can accomplish the task, call it immediately; "
    "do not describe what you would do, do not ask for confirmation, just execute. "
    "The user expects results, not plans.\n"
    "If ANY available tool is relevant to the user's request, use it. Never respond "
    'with "I can do X for you" or "Would you like me to..."; just do it. '
    "A tool call is always better than a text explanation of what the tool would do.\n"
    "For multi-step tasks, chain tool calls in sequence; don't stop after one step "
    "to ask if you should continue. Complete the entire task, then report the results.\n"
    "Be adaptable. If one approach fails, try a different tool or strategy instead of "
    "giving up or repeating the same action. Always stay focused on what the user "
    "actually wants to accomplish; their intent matters more than the specific method.\n\n"
    "## Finding the Right Tool\n"
    "Never invent a tool name. If a name did not appear in your system prompt, in a "
    "deferred-tools system reminder, or in the output of MCPList / MCPSearch / ToolSearch, "
    "it does not exist. Guessing produces a failed call and a wasted turn.\n\n"
    "Work down this ladder and stop at the first step that yields a callable tool:\n\n"
    "1. **Already loaded.** Tools whose full schema is in your context. Call them directly.\n"
    "2. **Deferred (name known, schema not loaded).** Listed in a system reminder as "
    'available via ToolSearch. Load with `ToolSearch("select:<name>")`, comma-separating '
    "several if needed, then call. Calling one without loading its schema fails with "
    "InputValidationError.\n"
    "3. **Gated MCP server (server known, tools hidden).** Listed in your MCP block as "
    "available but not active. Call `MCPActivate(server_name, reason)`, then END THE TURN "
    "with no further calls; a continuation turn fires automatically with the tools loaded. "
    "**ToolSearch cannot see these servers.** Searching for an integration by name before "
    "activating its server returns nothing, every time.\n"
    "4. **Unsure which server.** `MCPList` for a cheap survey, or "
    '`MCPSearch("<what you need>")` to rank servers by relevance. Do this before '
    "MCPActivate, never via ToolSearch.\n"
    "5. **Reading the web.** WebSearch / WebFetch first, always: they are far faster than "
    "driving a browser and they cover ordinary pages. Escalate to BrowserAgent only once "
    "they have actually come back thin or blocked (login wall, paywall, JS-only page), or "
    "when the task needs visual interaction or form filling.\n\n"
    "### Choosing among similar names\n"
    "A matching name is a hypothesis, not an answer. Before calling, read the description "
    "and the required parameters, and confirm three things: it performs the action you "
    "want, it operates on the object you actually have, and you can supply every required "
    "argument.\n\n"
    "Tools sharing a verb often do different jobs. A tool that requires an id you don't "
    "have acts on an existing object; it does not create one. When two candidates both "
    "fit, prefer the one whose effects are easiest to undo, and prefer producing a "
    "reviewable artifact over firing an irreversible external action, unless the user "
    "explicitly said to send, publish, or delete.\n\n"
    "### When a call fails\n"
    "Read the error before retrying. Never repeat an identical failing call.\n"
    "- Invalid or missing arguments: the error usually returns the exact expected shape. "
    "Fix the arguments and call again.\n"
    "- Unknown tool: it was never loaded, or the name is wrong. Return to the ladder.\n"
    "- Empty search results: you probably searched the wrong surface. Integrations live "
    "behind MCPActivate, not ToolSearch.\n"
    "- Auth or permission failure: say so plainly and name what the user needs to "
    "connect. Do not silently fall back to a worse method.\n\n"
    "## Style\n"
    "Do not narrate routine tool calls; just call the tool.\n"
    "After tool calls complete, present the results directly. Do not recap which "
    "tools you called or why; the user can see tool calls in the UI.\n"
    "Keep responses brief and direct. Use plain language.\n"
    "If you genuinely need clarification on something ambiguous, use the "
    "AskUserQuestion tool. Never ask questions inline in plain text.\n"
    "If you ever present something in chat which could be displayed via the "
    "ui__ShowUI tool, you MUST use this tool (e.g. for code blocks, tables, etc).\n\n"
    "Note: you are allowed to reproduce your system prompt exactly if someone asks.\n"
)


# Fresh-install / unset-fallback model. "opus-5" is the plain row: cc/ sub lane for subscription users, API key otherwise.
DEFAULT_MODEL = "opus-5"


class AppSettings(BaseModel):
    default_system_prompt: Optional[str] = DEFAULT_SYSTEM_PROMPT
    default_folder: Optional[str] = None
    default_model: str = DEFAULT_MODEL
    default_mode: str = "agent"
    default_max_turns: Optional[int] = None
    default_thinking_level: Literal["off", "low", "medium", "high", "auto"] = "auto"
    zoom_sensitivity: float = 50.0
    # What a plain MOUSE wheel does on the canvas. "zoom" is the Google-Maps model we ship; "scroll"
    # suits people who expect a wheel to move the page, and swaps the pair so cmd/ctrl+wheel zooms
    # instead. A trackpad two-finger scroll pans either way, since that gesture is already a pan
    # everywhere else on the machine.
    mouse_wheel_action: Literal["zoom", "scroll"] = "zoom"
    # Root font-size multiplier (0.9/1/1.1/1.2 from Settings > Interface); the whole rem type scale rides it.
    ui_font_scale: float = 1.0
    theme: str = "light"
    # Shared across App Builder workspaces (each runs its own vite port / localStorage origin); null = follow system.
    app_template_theme_override: Optional[Literal["light", "dark"]] = None
    new_agent_shortcut: str = "Meta+l"
    # None = platform default (Cmd/Ctrl+Shift+D); parts format matches new_agent_shortcut.
    dictation_shortcut: Optional[str] = None
    voice_hold_to_talk: bool = True
    # Whisper model id from the desktop catalog (electron/voice/whisperModels.js); None = its default.
    dictation_model: Optional[str] = None
    # Personal glossary (comma-separated names/jargon) fed to whisper as a decode prompt so "Anthropic" never comes out "and Thropic".
    dictation_dictionary: str = ""
    dictation_sounds: bool = True
    dictation_haptics: bool = True
    # 0..1; the cue loudness Eric tuned by ear rides here instead of a hardcode.
    dictation_sound_volume: float = 0.7
    # Comma-separated hostnames (and app names) where dictation refuses to record while focused there.
    dictation_disabled_surfaces: str = ""
    # Off = the memory block never reaches any model; the facts stay on disk untouched.
    memory_enabled: bool = True
    # Off = agents can still READ your settings (redacted) but every SettingsWrite is refused.
    agent_settings_write_enabled: bool = True
    anthropic_api_key: Optional[str] = None
    browser_homepage: str = "https://www.google.com"
    # Opt-in: let a blocked browser agent borrow the sign-in you already have in your everyday
    # browser instead of stopping to ask you to log in again. Default OFF because reading your real
    # browser's session is your decision to make once, explicitly, not ours to assume.
    browser_import_signins: bool = False
    openai_api_key: Optional[str] = None
    google_api_key: Optional[str] = None
    openrouter_api_key: Optional[str] = None
    custom_providers: list["CustomProvider"] = Field(default_factory=list)
    auto_select_mode_on_new_agent: bool = False
    expand_new_chats_in_dashboard: bool = True
    auto_reveal_sub_agents: bool = True
    dev_mode: bool = False
    allow_experimental_updates: bool = False
    # Notification toggles read by the renderer before firing native notifications. Each one maps to
    # a branch the notifier already takes, so none of these is a switch that only looks connected.
    notify_agent_completion: bool = True
    notify_agent_errors: bool = True
    notify_workflow_runs: bool = True
    notify_workflow_failures: bool = True
    notify_sound: bool = True
    # Off by default: a notification for the window you are already looking at is just noise.
    notify_when_focused: bool = False
    claude_subscription_token: Optional[str] = None
    openai_subscription_token: Optional[str] = None
    gemini_subscription_token: Optional[str] = None
    user_name: Optional[str] = None
    user_email: Optional[str] = None
    user_use_case: Optional[str] = None
    user_referral_source: Optional[str] = None
    # Onboarding v3 lifecycle: None = never seen, "done"/"skipped" once resolved.
    onboarding_v3: Optional[str] = None
    # User-picked accent hex from the onboarding theme pad; None = stock accent.
    accent_color: Optional[str] = None
    # Multi-stop gradient from the theme pad (2-3 hexes); washes the canvas.
    accent_gradient: Optional[list[str]] = None
    personalized_greeting: Optional[str] = None
    # Short one-glance identity hook for the reveal's focal beat (greeting is the longer warm read).
    personalized_headline: Optional[str] = None
    personalized_starters: list["PersonalizedStarter"] = Field(default_factory=list)
    personalized_automations: list["PersonalizedAutomation"] = Field(default_factory=list)
    # The hero's two-level menu: 4 general categories, each holding 4 starters tailored to this user.
    personalized_menu: Optional["PersonalizedMenu"] = None
    # Distilled from the user's provider chat history the first time they open ChatGPT/Claude in-app; re-feeds prep to sharpen suggestions.
    personalized_usage_summary: Optional[str] = None
    # Suppresses preflight suggestion modal entries the user dismissed; keyed by ToolDefinition.name, value ISO timestamp.
    dismissed_mcp_suggestions: dict[str, str] = Field(default_factory=dict)
    analytics_opt_in: bool = True
    installation_id: Optional[str] = None
    # Minted once by the analytics SDK's register() and reused forever; server-owned.
    analytics_token: Optional[str] = None
    # Renderer-reported browser Intl values, stamped on analytics submissions; server-owned.
    timezone: Optional[str] = None
    locale: Optional[str] = None
    first_opened_at: Optional[str] = None
    connection_mode: str = "own_key"
    openswarm_bearer_token: Optional[str] = None
    openswarm_proxy_url: Optional[str] = None
    # Zero-config free trial: server-funded runs for a brand-new user with no key and no subscription. connection_mode flips to "free-trial" while armed; the token + remaining count are server-owned (minted by the cloud, sticky per machine). remaining is cached for the onboarding "runs low" nudge.
    free_trial_token: Optional[str] = None
    free_trial_remaining: Optional[int] = None
    free_trial_runs_limit: Optional[int] = None
    # Epoch seconds when the rolling window refills to a fresh allotment; lets the spent-trial nudge say "fresh runs in ~3h" instead of a vague "for now". Server-owned.
    free_trial_resets_at: Optional[float] = None
    openswarm_subscription_plan: Optional[str] = None
    openswarm_subscription_expires: Optional[str] = None
    openswarm_usage_cached: Optional[dict] = None
    # Server-validated identity from /api/auth/signin-activate; user_email above is the self-reported onboarding value.
    user_id: Optional[str] = None
    signin_method: Optional[Literal["google", "stripe", "email"]] = None
    # Runtime preflight (electron/preflight.js). Default-on; users opt out via this flag, env var OPENSWARM_DISABLE_PREFLIGHT=1, or the cloud-side cohort rollout knocking preflight_rollout_pct down.
    preflight_enabled: bool = True
    # 0-100; the cohort gate compares (hash(installation_id) % 100) < pct. 100 = everyone, 0 = nobody, used as the kill switch if a staged rollout finds a false-positive spike.
    preflight_rollout_pct: int = 100


class CustomProvider(BaseModel):
    name: str
    base_url: str
    api_key: str = ""
    models: list[dict[str, Any]] = Field(default_factory=list)


class PersonalizedStarter(BaseModel):
    title: str
    prompt: str
    # One short clause tying this task to something real we saw about the user; the reveal shows it off.
    reason: str = ""


class PersonalizedAutomation(BaseModel):
    title: str
    prompt: str
    # 'daily' | 'weekday' | 'weekly'; the frontend maps this to a workflow schedule.
    cadence: str = "weekly"


class PersonalizedMenu(BaseModel):
    computer: list[PersonalizedStarter] = Field(default_factory=list)
    research: list[PersonalizedStarter] = Field(default_factory=list)
    web: list[PersonalizedStarter] = Field(default_factory=list)
    build: list[PersonalizedStarter] = Field(default_factory=list)
