"""Provider registry and model catalog.

NOTE: `create_provider`, `BaseProvider`, `AnthropicProvider`, `OpenAICompatProvider`,
and the native `AgentLoop` are currently unused. The live agent path is
`claude_agent_sdk` via `agent_manager._run_agent_loop`. Kept as a foundation
for a potential future native multi-provider loop.

Multi-model subscription support routes non-Anthropic models through 9Router's
`/v1/messages` endpoint by passing prefixed model IDs (e.g. `cx/gpt-5.4`,
`gc/gemini-2.5-pro`, `gh/claude-sonnet-4`). 9Router's translator converts the
Anthropic-format request into the provider's native format transparently.
"""

from __future__ import annotations

import logging
from typing import Any, TYPE_CHECKING

from backend.apps.agents.providers.base import BaseProvider

if TYPE_CHECKING:
    from backend.apps.settings.models import AppSettings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tier 1: Built-in models (curated, we know their quirks)
# ---------------------------------------------------------------------------
#
# Fields:
#   value            — short internal name stored on AgentSession.model
#   label            — display name in the model picker
#   context_window   — tokens
#   model_id         — bare model string for direct API calls (Anthropic key path)
#   router_model_id  — prefixed string for 9Router routing (cc/, cx/, gc/, gh/)
#   api              — "anthropic" | "codex" | "gemini-cli" | "github-copilot"
#   subscription_only— True means hidden from picker unless 9Router has that
#                      provider actively connected
#   reasoning        — True for models that emit Anthropic `thinking` content
#                      blocks via 9Router's translator. OpenSwarm's stream
#                      handler at agent_manager.py:1141-1165 does not yet
#                      render these blocks — final text still appears but
#                      the reasoning trace is silently dropped. Tracked as
#                      a follow-up; add a `thinking` case to the handler
#                      to surface the trace.
#
# Model IDs match 9Router's internal routing catalog at
# 9router/src/shared/constants/pricing.js. Each provider has a distinct
# model-name convention:
#   - cc/  (Claude Code subscription) uses dash-notation: claude-sonnet-4-6
#   - cx/  (OpenAI Codex subscription) uses dot-notation with -codex suffix.
#          Note: `gpt-5.4` is NOT available on this path — it's API-key-only.
#          The Codex subscription's flagship is gpt-5.3-codex.
#   - gc/  (Gemini CLI subscription) uses gemini-3-pro-preview / 3-flash-preview
#          (thinking-capable) and gemini-2.5-pro / 2.5-flash (stable).
#          Gemini 3 thought signatures handled via skip_thought_signature_validator.
#   - gh/  (GitHub Copilot) uses dot-notation (claude-sonnet-4.6 not
#          claude-sonnet-4-6) because Copilot has its own model catalog
#          independent from Anthropic's API naming.

BUILTIN_MODELS: dict[str, list[dict[str, Any]]] = {
    # Anthropic: current-gen trio. Sonnet 4.6 (Feb 17 2026), Opus 4.6
    # (Feb 5 2026), Haiku 4.5 (Oct 2025). All three are the current
    # production flagships in their respective size tiers.
    "Anthropic": [
        # Adaptive entries: route is chosen at call time based on
        # settings.connection_mode (openswarm-pro → proxy; api_key → direct;
        # else → 9Router cc/).
        {"value": "sonnet", "label": "Claude Sonnet 4.6", "context_window": 1_000_000,
         "model_id": "claude-sonnet-4-6", "router_model_id": "cc/claude-sonnet-4-6", "api": "anthropic", "reasoning": True},
        {"value": "opus", "label": "Claude Opus 4.6", "context_window": 1_000_000,
         "model_id": "claude-opus-4-6", "router_model_id": "cc/claude-opus-4-6", "api": "anthropic", "reasoning": True},
        {"value": "haiku", "label": "Claude Haiku 4.5", "context_window": 200_000,
         "model_id": "claude-haiku-4-5", "router_model_id": "cc/claude-haiku-4-5-20251001", "api": "anthropic", "reasoning": True},
        # Pinned-subscription entries: always route via 9Router's `cc/` prefix
        # (the user's personal Claude Pro/Max subscription), regardless of
        # connection_mode. Surfaced in list_models only when the user has
        # BOTH openswarm-pro active AND the 9Router `claude` subscription
        # connected — so the model picker can offer a per-call choice between
        # the managed OpenSwarm proxy and their own Claude subscription.
        {"value": "sonnet-cc", "label": "Claude Sonnet 4.6", "context_window": 1_000_000,
         "model_id": "claude-sonnet-4-6", "router_model_id": "cc/claude-sonnet-4-6", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "opus-cc", "label": "Claude Opus 4.6", "context_window": 1_000_000,
         "model_id": "claude-opus-4-6", "router_model_id": "cc/claude-opus-4-6", "api": "anthropic", "reasoning": True, "route": "cc"},
        {"value": "haiku-cc", "label": "Claude Haiku 4.5", "context_window": 200_000,
         "model_id": "claude-haiku-4-5", "router_model_id": "cc/claude-haiku-4-5-20251001", "api": "anthropic", "reasoning": True, "route": "cc"},
    ],
    # OpenAI: ChatGPT Plus/Pro (Codex) subscription. gpt-5.4 is the
    # current flagship — combines GPT-5.3 Codex coding capabilities with
    # stronger reasoning, tool use, and agentic workflows.
    # See: https://developers.openai.com/codex/models
    "OpenAI": [
        {"value": "gpt-5.4", "label": "GPT-5.4",
         "context_window": 1_000_000, "router_model_id": "cx/gpt-5.4",
         "api": "codex", "subscription_only": True, "reasoning": True},
        {"value": "gpt-5.4-mini", "label": "GPT-5.4 Mini",
         "context_window": 400_000, "router_model_id": "cx/gpt-5.4-mini",
         "api": "codex", "subscription_only": True, "reasoning": True},
        {"value": "gpt-5.3-codex", "label": "GPT-5.3 Codex",
         "context_window": 400_000, "router_model_id": "cx/gpt-5.3-codex",
         "api": "codex", "subscription_only": True, "reasoning": True},
    ],
    # Google: Gemini via Gemini CLI subscription. Both 3.x (thinking-
    # capable) and 2.5 (stable) are offered. Gemini 3 models have
    # always-on thinking with per-session thought signatures that are
    # lost during the format translation round-trip. We use Google's
    # official workaround: `skip_thought_signature_validator` on all
    # historical function call and thinking parts (see 9router
    # openai-to-gemini.js). This bypasses signature validation at the
    # cost of the model not being able to build on prior reasoning
    # across turns — but all tools work and thinking is visible.
    "Google": [
        {"value": "gemini-3-pro", "label": "Gemini 3 Pro",
         "context_window": 1_000_000, "router_model_id": "gc/gemini-3-pro-preview",
         "api": "gemini-cli", "subscription_only": True, "reasoning": True},
        {"value": "gemini-3-flash", "label": "Gemini 3 Flash",
         "context_window": 1_000_000, "router_model_id": "gc/gemini-3-flash-preview",
         "api": "gemini-cli", "subscription_only": True, "reasoning": True},
        {"value": "gemini-2.5-pro", "label": "Gemini 2.5 Pro",
         "context_window": 1_000_000, "router_model_id": "gc/gemini-2.5-pro",
         "api": "gemini-cli", "subscription_only": True},
        {"value": "gemini-2.5-flash", "label": "Gemini 2.5 Flash",
         "context_window": 1_000_000, "router_model_id": "gc/gemini-2.5-flash",
         "api": "gemini-cli", "subscription_only": True},
    ],
    # GitHub Copilot — all plans (Free/Pro/Pro+) have access to the SAME
    # models, just with different premium request quotas (50/300/1500).
    # Model IDs MUST match 9Router's `gh:` pricing catalog at
    # 9router/src/shared/constants/pricing.js — NOT the Codex CLI catalog.
    # Copilot uses its own model IDs (dot-notation for Claude versions,
    # different names from Codex CLI for some GPT models).
    # See: https://github.com/features/copilot/plans
    "OpenSwarm": [
        # --- Free-tier friendly (low premium request cost) ---
        {"value": "gpt-5-mini", "label": "GPT-5 Mini",
         "context_window": 200_000, "router_model_id": "gh/gpt-5-mini",
         "api": "github-copilot", "subscription_only": True},
        {"value": "claude-haiku-4.5", "label": "Claude Haiku 4.5",
         "context_window": 200_000, "router_model_id": "gh/claude-haiku-4.5",
         "api": "github-copilot", "subscription_only": True},
        {"value": "grok-code-fast-1", "label": "Grok Code Fast 1",
         "context_window": 128_000, "router_model_id": "gh/grok-code-fast-1",
         "api": "github-copilot", "subscription_only": True},
        {"value": "gpt-4.1", "label": "GPT-4.1",
         "context_window": 128_000, "router_model_id": "gh/gpt-4.1",
         "api": "github-copilot", "subscription_only": True},
        # --- Premium models (consume more premium requests) ---
        {"value": "claude-sonnet-4.6", "label": "Claude Sonnet 4.6",
         "context_window": 200_000, "router_model_id": "gh/claude-sonnet-4.6",
         "api": "github-copilot", "subscription_only": True},
        {"value": "claude-opus-4.6", "label": "Claude Opus 4.6",
         "context_window": 200_000, "router_model_id": "gh/claude-opus-4.6",
         "api": "github-copilot", "subscription_only": True},
        {"value": "gpt-5.3-codex", "label": "GPT-5.3 Codex",
         "context_window": 400_000, "router_model_id": "gh/gpt-5.3-codex",
         "api": "github-copilot", "subscription_only": True, "reasoning": True},
        {"value": "gemini-3-pro", "label": "Gemini 3 Pro",
         "context_window": 1_000_000, "router_model_id": "gh/gemini-3-pro-preview",
         "api": "github-copilot", "subscription_only": True, "reasoning": True},
        {"value": "gemini-3-flash", "label": "Gemini 3 Flash",
         "context_window": 1_000_000, "router_model_id": "gh/gemini-3-flash-preview",
         "api": "github-copilot", "subscription_only": True, "reasoning": True},
        {"value": "gemini-2.5-pro", "label": "Gemini 2.5 Pro",
         "context_window": 1_000_000, "router_model_id": "gh/gemini-2.5-pro",
         "api": "github-copilot", "subscription_only": True},
    ],
}

# ---------------------------------------------------------------------------
# Thinking level translation
# ---------------------------------------------------------------------------
# Each provider has a different API shape for "how hard should the model
# think." We expose a single provider-agnostic level (off/low/medium/high/
# auto) on the session and translate here.
#
# Returns the provider-specific payload to merge into request params, or
# None if no special thinking params should be sent (use defaults).

def thinking_params_for(api: str, level: str, model_id: str = "") -> dict | None:
    """Translate a provider-agnostic thinking level to per-provider API params.

    Args:
        api: "anthropic" | "codex" | "gemini-cli" | "github-copilot"
        level: "off" | "low" | "medium" | "high" | "auto"
        model_id: optional, used to pick adaptive vs legacy for Claude

    Returns a dict to merge into request params, or None for "use defaults".
    """
    if level == "auto":
        # Let provider use its own default. For Claude 4.6 we still want
        # adaptive thinking on by default so users see reasoning.
        if api == "anthropic":
            return {"thinking": {"type": "adaptive"}}
        return None

    if level == "off":
        if api == "anthropic":
            return {"thinking": {"type": "disabled"}}
        if api == "codex":
            return {"reasoning": {"effort": "none"}}
        # Gemini: lowest available level
        if api == "gemini-cli":
            return {"thinkingConfig": {"thinkingLevel": "LOW"}}
        return None

    # Claude 4.6 models use adaptive thinking (no manual budget). For older
    # Claude models we'd use budget_tokens; we don't ship those today.
    if api == "anthropic":
        return {"thinking": {"type": "adaptive"}}

    if api == "codex":
        effort_map = {"low": "low", "medium": "medium", "high": "high"}
        return {"reasoning": {"effort": effort_map[level]}}

    if api == "gemini-cli":
        level_map = {"low": "LOW", "medium": "MEDIUM", "high": "HIGH"}
        return {"thinkingConfig": {"thinkingLevel": level_map[level]}}

    # github-copilot goes through 9Router and doesn't expose a thinking
    # param in its Copilot catalog — leave untouched.
    return None


# ---------------------------------------------------------------------------
# OpenRouter: built-in integration for 300+ models
# ---------------------------------------------------------------------------

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

_9router_cache: dict = {"available": None, "checked_at": 0}


def _is_9router_available() -> bool:
    """Check if 9Router is running on localhost:20128. Caches for 30 seconds."""
    import time as _time
    now = _time.time()
    if _9router_cache["available"] is not None and now - _9router_cache["checked_at"] < 30:
        return _9router_cache["available"]
    try:
        import httpx
        r = httpx.get("http://localhost:20128/v1/models", timeout=2.0)
        available = r.status_code == 200
    except Exception:
        available = False
    _9router_cache["available"] = available
    _9router_cache["checked_at"] = now
    return available


# ---------------------------------------------------------------------------
# Model resolution (used by the live claude_agent_sdk path)
# ---------------------------------------------------------------------------

def _find_builtin_model(short_name: str) -> dict | None:
    """Look up a model entry by its short `value`."""
    for models in BUILTIN_MODELS.values():
        for m in models:
            if m.get("value") == short_name:
                return m
    return None


def get_api_type(short_name: str) -> str:
    """Return the api type for a short model name.

    Returns one of: "anthropic", "codex", "gemini-cli", "github-copilot".
    Defaults to "anthropic" for unknown names so existing behavior is preserved.
    """
    entry = _find_builtin_model(short_name)
    return (entry or {}).get("api", "anthropic")


def resolve_model_id_for_sdk(short_name: str, settings: AppSettings) -> str:
    """Resolve a short model name into the id string passed to ClaudeAgentOptions.

    Priority:
    - Anthropic model + openswarm-pro mode → bare `model_id` (our cloud proxy)
    - Anthropic model with an API key set → bare `model_id` (real Anthropic API)
    - Everything else → `router_model_id` (9Router with cc/ cx/ gc/ gh/ prefix)
    - Unknown names pass through unchanged
    """
    entry = _find_builtin_model(short_name)
    if entry is None:
        return short_name
    # Pinned-route entries (e.g. "sonnet-cc") always use their router_model_id,
    # bypassing connection_mode. This is what lets the picker offer a
    # distinct "Anthropic" group pointing at the user's 9Router Claude
    # subscription even while openswarm-pro is the default Claude route.
    if entry.get("route") == "cc":
        return entry.get("router_model_id", entry.get("model_id", short_name))
    if entry.get("api") == "anthropic":
        if getattr(settings, "connection_mode", "own_key") == "openswarm-pro":
            return entry.get("model_id", short_name)
        if getattr(settings, "anthropic_api_key", None):
            return entry.get("model_id", short_name)
    return entry.get("router_model_id", entry.get("model_id", short_name))


async def resolve_aux_model(settings: AppSettings, preferred_tier: str = "haiku") -> tuple[str, str | None]:
    """Pick the cheapest/most-available model for auxiliary LLM calls.

    Used by title generation, group meta, dashboard naming, outputs/view
    builder, and browser_agent — wherever we need a quick one-shot LLM call
    that is NOT the user's selected chat model.

    Returns (model_id, base_url).
    - If base_url is None, caller should use the default Anthropic client.
    - If base_url is set, caller should route through 9Router.

    Priority:
    1. Anthropic API key set → bare haiku/sonnet on real Anthropic API
    2. 9Router + Claude subscription connected → cc/<model>
    3. 9Router + Codex connected → cx/gpt-5.4-mini
    4. 9Router + Gemini connected → gc/gemini-2.5-flash
    5. 9Router + Copilot connected → gh/gpt-5
    6. Nothing available → raise ValueError
    """
    haiku_bare = "claude-haiku-4-5-20251001"
    sonnet_bare = "claude-sonnet-4-20250514"
    bare = haiku_bare if preferred_tier == "haiku" else sonnet_bare

    # OpenSwarm Pro — route through our cloud proxy
    if getattr(settings, "connection_mode", "own_key") == "openswarm-pro":
        proxy_url = getattr(settings, "openswarm_proxy_url", None) or "https://api.openswarm.com"
        return (bare, proxy_url)

    # Direct API key wins
    if getattr(settings, "anthropic_api_key", None):
        return (bare, None)

    # Fall back to 9Router
    from backend.apps.nine_router import is_running as _9r_running, get_providers as _9r_providers

    if not _9r_running():
        raise ValueError(
            "No AI provider configured for auxiliary LLM call. "
            "Set an Anthropic API key or connect a subscription."
        )

    providers_data = await _9r_providers()
    connections = providers_data.get("connections", []) if isinstance(providers_data, dict) else []
    connected = {c.get("provider") for c in connections if c.get("isActive")}

    base_url = "http://localhost:20128"
    if "claude" in connected:
        return (f"cc/{haiku_bare}" if preferred_tier == "haiku" else f"cc/{sonnet_bare}", base_url)
    if "codex" in connected:
        return ("cx/gpt-5.4-mini", base_url)
    if "gemini-cli" in connected:
        return ("gc/gemini-2.5-flash", base_url)
    if "github" in connected:
        return ("gh/gpt-5", base_url)

    raise ValueError(
        "No AI provider connected for auxiliary LLM call. "
        "Connect at least one subscription in Settings."
    )


# ---------------------------------------------------------------------------
# Provider factory
# ---------------------------------------------------------------------------

def create_provider(
    provider_name: str,
    settings: AppSettings,
    provider_config: dict | None = None,
) -> BaseProvider:
    """Create a provider adapter.

    Routes based on the 'api' field in BUILTIN_MODELS:
    - "anthropic" → native Anthropic SDK
    - "openai"    → native OpenAI SDK (direct API)
    - "gemini"    → native Google GenAI SDK
    - "openrouter" → OpenAI-compat via openrouter.ai (Meta, Mistral, DeepSeek, Qwen, xAI, etc.)
    Custom providers use OpenAI-compat with user's base_url.
    """
    api_type = _get_api_type(provider_name)

    # Check for 9Router first
    if provider_name in ("9Router", "9router"):
        from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
        return OpenAICompatProvider(api_key="9router", base_url="http://localhost:20128/v1")

    # NOTE: GitHub Copilot previously branched to a CopilotProvider imported
    # from backend.apps.agents.providers.copilot, but that module does not
    # exist (the file was never checked in). The branch was unreachable dead
    # code. Copilot subscription support now routes through 9Router's `gh/`
    # prefix via the main claude_agent_sdk path — see BUILTIN_MODELS and
    # resolve_model_id_for_sdk above.

    if api_type == "anthropic":
        from backend.apps.agents.providers.anthropic import AnthropicProvider
        if getattr(settings, "connection_mode", "own_key") == "openswarm-pro":
            return AnthropicProvider(
                auth_token=getattr(settings, "openswarm_bearer_token", None),
                base_url=getattr(settings, "openswarm_proxy_url", None) or "https://api.openswarm.com",
            )
        # Priority: API key → 9Router subscription
        if settings.anthropic_api_key:
            return AnthropicProvider(api_key=settings.anthropic_api_key)
        # No API key — try 9Router as fallback
        if _is_9router_available():
            from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
            provider = OpenAICompatProvider(api_key="9router", base_url="http://localhost:20128/v1")
            # Override get_model_id to map our short names to 9Router's cc/ prefixed IDs
            _original_get_model = provider.get_model_id
            _9r_model_map = {
                "sonnet": "cc/claude-sonnet-4-6",
                "opus": "cc/claude-opus-4-6",
                "haiku": "cc/claude-haiku-4-5-20251001",
            }
            provider.get_model_id = lambda name: _9r_model_map.get(name, f"cc/{name}" if not name.startswith("cc/") else name)
            return provider
        raise ValueError("Anthropic API key not configured. Set it in Settings, or connect 9Router.")

    if api_type == "openai":
        from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
        if settings.openai_api_key:
            return OpenAICompatProvider(api_key=settings.openai_api_key, base_url="https://api.openai.com/v1")
        # No API key — try 9Router as fallback
        if _is_9router_available():
            return OpenAICompatProvider(api_key="9router", base_url="http://localhost:20128/v1")
        raise ValueError("OpenAI API key not configured. Set it in Settings, or connect 9Router.")

    if api_type == "gemini":
        from backend.apps.agents.providers.gemini import GeminiProvider
        if settings.google_api_key:
            return GeminiProvider(api_key=settings.google_api_key)
        # No API key — try 9Router as fallback
        if _is_9router_available():
            from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
            return OpenAICompatProvider(api_key="9router", base_url="http://localhost:20128/v1")
        raise ValueError("Google API key not configured. Set it in Settings, or connect 9Router.")

    if api_type == "openrouter":
        from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
        openrouter_key = getattr(settings, "openrouter_api_key", None)
        if openrouter_key:
            return OpenAICompatProvider(api_key=openrouter_key, base_url=OPENROUTER_BASE_URL)
        # No OpenRouter key — try 9Router as fallback
        if _is_9router_available():
            return OpenAICompatProvider(api_key="9router", base_url="http://localhost:20128/v1")
        raise ValueError(f"OpenRouter API key not configured for {provider_name}. Set it in Settings, or connect a subscription.")

    # Custom provider — look up in settings.custom_providers
    if provider_config:
        from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
        return OpenAICompatProvider(
            api_key=provider_config.get("api_key", ""),
            base_url=provider_config.get("base_url", ""),
        )

    for cp in getattr(settings, "custom_providers", []):
        if cp.name == provider_name:
            from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
            return OpenAICompatProvider(
                api_key=cp.api_key,
                base_url=cp.base_url,
            )

    raise ValueError(f"Unknown provider: {provider_name}")


def _get_api_type(provider_name: str) -> str:
    """Get the API type for a provider from BUILTIN_MODELS.

    Accepts both display names ('Anthropic') and lowercase API names ('anthropic').
    """
    # Direct lookup first (display name like 'Anthropic', 'OpenAI', etc.)
    models = BUILTIN_MODELS.get(provider_name, [])
    if models:
        return models[0].get("api", "openrouter")

    # Lowercase API name mapping
    _API_NAME_MAP = {
        "anthropic": "anthropic",
        "openai": "openai",
        "gemini": "gemini",
        "google": "gemini",
        "openrouter": "openrouter",
    }
    if provider_name.lower() in _API_NAME_MAP:
        return _API_NAME_MAP[provider_name.lower()]

    # Case-insensitive lookup into BUILTIN_MODELS
    lower = provider_name.lower()
    for key, models in BUILTIN_MODELS.items():
        if key.lower() == lower:
            return models[0].get("api", "openrouter")

    return "openrouter"


def _has_credentials(provider_name: str, settings: AppSettings) -> bool:
    """Check if a provider has credentials configured."""
    api_type = _get_api_type(provider_name)

    if api_type == "anthropic":
        if getattr(settings, "connection_mode", "own_key") == "openswarm-pro":
            return bool(getattr(settings, "openswarm_bearer_token", None))
        return bool(settings.anthropic_api_key)
    if api_type == "openai":
        return bool(settings.openai_api_key)
    if api_type == "gemini":
        return bool(getattr(settings, "google_api_key", None))
    if api_type == "openrouter":
        return bool(getattr(settings, "openrouter_api_key", None))
    return False


def get_available_models(settings: AppSettings) -> dict[str, list[dict]]:
    """Return all models — always show everything, mark which have keys configured.

    Like Cursor: show all models upfront, prompt for key when user tries to use one.
    Returns: {"provider_name": [{"value": ..., "label": ..., "context_window": ..., "configured": bool}, ...]}
    """
    result: dict[str, list[dict]] = {}

    # Built-in providers — always show all
    for provider_name, models in BUILTIN_MODELS.items():
        configured = _has_credentials(provider_name, settings)
        result[provider_name] = [
            {**m, "configured": configured}
            for m in models
        ]

    # Custom providers
    for cp in getattr(settings, "custom_providers", []):
        if cp.models:
            result[cp.name] = [
                {
                    "value": m.get("value", m.get("id", "")),
                    "label": m.get("label", m.get("value", m.get("id", ""))),
                    "context_window": m.get("context_window", 128_000),
                    "configured": True,
                }
                for m in cp.models
            ]

    return result


def get_context_window(provider: str, model: str, settings: AppSettings | None = None) -> int:
    """Look up context window for any model."""
    # Check built-in models first
    for models in BUILTIN_MODELS.values():
        for m in models:
            if m["value"] == model:
                return m.get("context_window", 128_000)

    # Check custom providers
    if settings:
        for cp in getattr(settings, "custom_providers", []):
            for m in cp.models:
                if m.get("value") == model or m.get("id") == model:
                    return m.get("context_window", 128_000)

    return 128_000  # safe default


# ---------------------------------------------------------------------------
# Cost tracking
# ---------------------------------------------------------------------------

COST_PER_1M_TOKENS: dict[tuple[str, str], tuple[float, float]] = {
    # (provider, model): (input_cost_per_1M, output_cost_per_1M)
    # NOTE: `calculate_cost` is currently unused in the live path — real
    # cost tracking comes from 9Router's usage stats (analytics.py:270+).
    # These entries are kept so the table matches BUILTIN_MODELS and can
    # be used by any future native-loop path. Subscription-routed models
    # are zero-cost to the user, but API rates are recorded here for
    # reference where they exist.
    # Anthropic (direct API rates)
    ("Anthropic", "sonnet"): (3.0, 15.0),
    ("Anthropic", "opus"): (5.0, 25.0),
    ("Anthropic", "haiku"): (1.0, 5.0),
    # OpenAI — Codex subscription path, user pays nothing per token
    ("OpenAI", "gpt-5.4"): (0.0, 0.0),
    ("OpenAI", "gpt-5.4-mini"): (0.0, 0.0),
    ("OpenAI", "gpt-5.3-codex"): (0.0, 0.0),
    # Google — Gemini CLI subscription path, user pays nothing per token
    ("Google", "gemini-3-pro"): (0.0, 0.0),
    ("Google", "gemini-3-flash"): (0.0, 0.0),
    ("Google", "gemini-2.5-pro"): (0.0, 0.0),
    ("Google", "gemini-2.5-flash"): (0.0, 0.0),
    # OpenRouter-backed (approximate)
    ("xAI", "x-ai/grok-4-0214"): (3.0, 15.0),
    ("Meta", "meta-llama/llama-4-maverick"): (0.50, 0.70),
    ("Meta", "meta-llama/llama-4-scout"): (0.15, 0.40),
    ("DeepSeek", "deepseek/deepseek-chat-v3-0324"): (0.30, 0.90),
    ("DeepSeek", "deepseek/deepseek-r1"): (0.80, 2.40),
    ("Mistral", "mistralai/mistral-large-2501"): (2.0, 6.0),
    ("Mistral", "mistralai/mistral-small-3.1-24b-instruct"): (0.10, 0.30),
    ("Qwen", "qwen/qwen3-coder"): (0.0, 0.0),
    ("Qwen", "qwen/qwen3-235b-a22b"): (0.20, 0.70),
    ("Cohere", "cohere/command-a-03-2025"): (2.50, 10.0),
    # GitHub Copilot (subscription-routed; no per-token cost)
    ("OpenSwarm", "claude-sonnet-4.6"): (0.0, 0.0),
    ("OpenSwarm", "claude-opus-4.6"): (0.0, 0.0),
    ("OpenSwarm", "claude-haiku-4.5"): (0.0, 0.0),
    ("OpenSwarm", "gpt-5.3-codex"): (0.0, 0.0),
    ("OpenSwarm", "gpt-5-mini"): (0.0, 0.0),
    ("OpenSwarm", "gpt-4.1"): (0.0, 0.0),
    ("OpenSwarm", "grok-code-fast-1"): (0.0, 0.0),
    ("OpenSwarm", "gemini-3-pro"): (0.0, 0.0),
    ("OpenSwarm", "gemini-3-flash"): (0.0, 0.0),
    ("OpenSwarm", "gemini-2.5-pro"): (0.0, 0.0),
}


def calculate_cost(
    provider: str, model: str,
    input_tokens: int, output_tokens: int,
) -> float:
    """Calculate cost in USD from token counts."""
    # Direct lookup first
    rates = COST_PER_1M_TOKENS.get((provider, model))
    if not rates:
        # Case-insensitive provider lookup
        lower = provider.lower()
        for (p, m), r in COST_PER_1M_TOKENS.items():
            if p.lower() == lower and m == model:
                rates = r
                break
    if not rates:
        return 0.0
    input_rate, output_rate = rates
    return (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000
