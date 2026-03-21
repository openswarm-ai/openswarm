"""Provider factory and model registry.

Two-tier system:
1. Built-in providers (Anthropic, OpenAI, Gemini) with curated model lists
2. User-configured custom providers (any OpenAI-compatible endpoint)
   - Includes built-in OpenRouter integration for 300+ models
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

BUILTIN_MODELS: dict[str, list[dict[str, Any]]] = {
    # ── Native API providers (use direct SDK) ──
    "Anthropic": [
        {"value": "sonnet", "label": "Claude Sonnet 4.6", "context_window": 1_000_000, "model_id": "claude-sonnet-4-6", "api": "anthropic"},
        {"value": "opus", "label": "Claude Opus 4.6", "context_window": 1_000_000, "model_id": "claude-opus-4-6", "api": "anthropic"},
        {"value": "haiku", "label": "Claude Haiku 4.5", "context_window": 200_000, "model_id": "claude-haiku-4-5", "api": "anthropic"},
    ],
    "OpenAI": [
        {"value": "gpt-5.4", "label": "GPT-5.4", "context_window": 1_000_000, "api": "openai"},
        {"value": "gpt-5.4-mini", "label": "GPT-5.4 Mini", "context_window": 400_000, "api": "openai"},
        {"value": "o3", "label": "o3", "context_window": 200_000, "api": "openai"},
        {"value": "o4-mini", "label": "o4-mini", "context_window": 200_000, "api": "openai"},
    ],
    "Google": [
        {"value": "gemini-2.5-pro", "label": "Gemini 2.5 Pro", "context_window": 1_048_576, "api": "gemini"},
        {"value": "gemini-2.5-flash", "label": "Gemini 2.5 Flash", "context_window": 1_048_576, "api": "gemini"},
    ],
    # ── Via OpenRouter (need OpenRouter API key) ──
    "xAI": [
        {"value": "x-ai/grok-4-0214", "label": "Grok 4", "context_window": 2_000_000, "api": "openrouter"},
    ],
    "Meta": [
        {"value": "meta-llama/llama-4-maverick", "label": "Llama 4 Maverick", "context_window": 1_000_000, "api": "openrouter"},
        {"value": "meta-llama/llama-4-scout", "label": "Llama 4 Scout", "context_window": 10_000_000, "api": "openrouter"},
    ],
    "DeepSeek": [
        {"value": "deepseek/deepseek-chat-v3-0324", "label": "DeepSeek V3", "context_window": 163_840, "api": "openrouter"},
        {"value": "deepseek/deepseek-r1", "label": "DeepSeek R1", "context_window": 163_840, "api": "openrouter"},
    ],
    "Mistral": [
        {"value": "mistralai/mistral-large-2501", "label": "Mistral Large", "context_window": 256_000, "api": "openrouter"},
        {"value": "mistralai/mistral-small-3.1-24b-instruct", "label": "Mistral Small 3.1", "context_window": 128_000, "api": "openrouter"},
    ],
    "Qwen": [
        {"value": "qwen/qwen3-coder", "label": "Qwen3 Coder 480B", "context_window": 262_144, "api": "openrouter"},
        {"value": "qwen/qwen3-235b-a22b", "label": "Qwen3 235B", "context_window": 131_072, "api": "openrouter"},
    ],
    "Cohere": [
        {"value": "cohere/command-a-03-2025", "label": "Command A", "context_window": 256_000, "api": "openrouter"},
    ],
}

# ---------------------------------------------------------------------------
# OpenRouter: built-in integration for 300+ models
# ---------------------------------------------------------------------------

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


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

    if api_type == "anthropic":
        from backend.apps.agents.providers.anthropic import AnthropicProvider
        if getattr(settings, "connection_mode", "own_key") == "managed":
            return AnthropicProvider(
                auth_token=getattr(settings, "openswarm_auth_token", None),
                base_url=getattr(settings, "openswarm_proxy_url", None) or "https://api.openswarm.ai",
            )
        return AnthropicProvider(api_key=settings.anthropic_api_key)

    if api_type == "openai":
        from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
        return OpenAICompatProvider(
            api_key=settings.openai_api_key or "",
            base_url="https://api.openai.com/v1",
        )

    if api_type == "gemini":
        from backend.apps.agents.providers.gemini import GeminiProvider
        return GeminiProvider(api_key=settings.google_api_key or "")

    if api_type == "openrouter":
        from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
        return OpenAICompatProvider(
            api_key=getattr(settings, "openrouter_api_key", "") or "",
            base_url=OPENROUTER_BASE_URL,
        )

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
        if getattr(settings, "connection_mode", "own_key") == "managed":
            return bool(getattr(settings, "openswarm_auth_token", None))
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
    # Anthropic
    ("Anthropic", "sonnet"): (3.0, 15.0),
    ("Anthropic", "opus"): (5.0, 25.0),
    ("Anthropic", "haiku"): (1.0, 5.0),
    # OpenAI
    ("OpenAI", "gpt-5.4"): (2.50, 15.0),
    ("OpenAI", "gpt-5.4-mini"): (0.75, 3.0),
    ("OpenAI", "o3"): (2.0, 8.0),
    ("OpenAI", "o4-mini"): (1.10, 4.40),
    # Google
    ("Google", "gemini-2.5-flash"): (0.15, 0.60),
    ("Google", "gemini-2.5-pro"): (1.25, 10.0),
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
