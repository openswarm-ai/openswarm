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
from backend.apps.common.model_registry import (
    get_builtin_models_by_provider,
    get_context_window as _registry_get_context_window,
    calculate_cost as _registry_calculate_cost,
)

if TYPE_CHECKING:
    from backend.apps.settings.models import AppSettings

logger = logging.getLogger(__name__)

BUILTIN_MODELS = get_builtin_models_by_provider()

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

    # Check for GitHub Copilot
    if provider_name in ("GitHub Copilot", "copilot"):
        from backend.apps.agents.providers.copilot import CopilotProvider
        copilot_token = getattr(settings, "copilot_token", None)
        if not copilot_token:
            raise ValueError("GitHub Copilot not connected. Sign in via Settings → Models.")
        # Auto-refresh if expired
        import time as _time
        expires = getattr(settings, "copilot_token_expires", None)
        if expires and _time.time() > expires - 120:
            github_token = getattr(settings, "copilot_github_token", None)
            if github_token:
                import asyncio
                from backend.apps.agents.copilot_auth import exchange_for_copilot_token
                try:
                    loop = asyncio.get_event_loop()
                    result = loop.run_until_complete(exchange_for_copilot_token(github_token))
                    copilot_token = result["token"]
                    settings.copilot_token = copilot_token
                    settings.copilot_token_expires = result["expires_at"]
                    from backend.apps.settings.settings import _save_settings
                    _save_settings(settings)
                except Exception as e:
                    logger.warning(f"Copilot token refresh failed: {e}")
        return CopilotProvider(copilot_token=copilot_token)

    if api_type == "anthropic":
        from backend.apps.agents.providers.anthropic import AnthropicProvider
        if getattr(settings, "connection_mode", "own_key") == "managed":
            return AnthropicProvider(
                auth_token=getattr(settings, "openswarm_auth_token", None),
                base_url=getattr(settings, "openswarm_proxy_url", None) or "https://api.openswarm.ai",
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
    result = _registry_get_context_window(model)
    if result != 128_000:
        return result

    if settings:
        for cp in getattr(settings, "custom_providers", []):
            for m in cp.models:
                if m.get("value") == model or m.get("id") == model:
                    return m.get("context_window", 128_000)

    return 128_000


def calculate_cost(
    provider: str, model: str,
    input_tokens: int, output_tokens: int,
) -> float:
    """Calculate cost in USD from token counts."""
    return _registry_calculate_cost(provider, model, input_tokens, output_tokens)
