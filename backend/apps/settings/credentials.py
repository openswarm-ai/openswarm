"""Centralized credential resolution for LLM API calls.

Supports multiple providers: Anthropic (native), OpenAI, Gemini,
OpenRouter, and user-configured custom providers.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import anthropic
    from backend.apps.settings.models import AppSettings

OPENSWARM_DEFAULT_PROXY_URL = "https://api.openswarm.ai"


def validate_credentials(settings: AppSettings, provider: str = "anthropic") -> None:
    """Raise ValueError if credentials are missing for the given provider."""
    if provider == "anthropic":
        if getattr(settings, "connection_mode", "own_key") == "managed":
            if not getattr(settings, "openswarm_auth_token", None):
                raise ValueError(
                    "Open Swarm account not connected. Sign in via Settings → API."
                )
        else:
            if not settings.anthropic_api_key:
                raise ValueError(
                    "Anthropic API key not configured. Set it in Settings."
                )
    elif provider == "openai":
        if not settings.openai_api_key:
            raise ValueError("OpenAI API key not configured. Set it in Settings.")
    elif provider == "gemini":
        if not getattr(settings, "google_api_key", None):
            raise ValueError("Google API key not configured. Set it in Settings.")
    elif provider == "openrouter":
        if not getattr(settings, "openrouter_api_key", None):
            raise ValueError("OpenRouter API key not configured. Set it in Settings.")
    else:
        # Custom provider — check if it exists in custom_providers
        for cp in getattr(settings, "custom_providers", []):
            if cp.name == provider:
                return  # Custom providers may have empty api_key (e.g. local Ollama)
        raise ValueError(f"Provider '{provider}' not found in settings.")


def get_provider_credentials(settings: AppSettings, provider: str) -> dict[str, str]:
    """Return credential dict for a specific provider."""
    validate_credentials(settings, provider)

    if provider == "anthropic":
        if getattr(settings, "connection_mode", "own_key") == "managed":
            return {
                "auth_token": getattr(settings, "openswarm_auth_token", "") or "",
                "base_url": getattr(settings, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL,
            }
        return {"api_key": settings.anthropic_api_key or ""}

    if provider == "openai":
        return {"api_key": settings.openai_api_key or ""}

    if provider == "gemini":
        return {"api_key": getattr(settings, "google_api_key", "") or ""}

    if provider == "openrouter":
        return {"api_key": getattr(settings, "openrouter_api_key", "") or ""}

    # Custom provider
    for cp in getattr(settings, "custom_providers", []):
        if cp.name == provider:
            return {"api_key": cp.api_key, "base_url": cp.base_url}

    raise ValueError(f"No credentials for provider: {provider}")


# ---------------------------------------------------------------------------
# Legacy helpers (kept for backward compat during migration)
# ---------------------------------------------------------------------------

def get_agent_sdk_env(settings: AppSettings) -> dict[str, str]:
    """Return the env dict for ClaudeAgentOptions based on connection mode.

    DEPRECATED: Use create_provider() from providers.registry instead.
    """
    validate_credentials(settings, "anthropic")

    if getattr(settings, "connection_mode", "own_key") == "managed":
        proxy_url = getattr(settings, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL
        return {
            "ANTHROPIC_AUTH_TOKEN": getattr(settings, "openswarm_auth_token", ""),
            "ANTHROPIC_BASE_URL": proxy_url,
        }

    return {"ANTHROPIC_API_KEY": settings.anthropic_api_key}


def get_anthropic_client(settings: AppSettings) -> anthropic.AsyncAnthropic:
    """Return a configured AsyncAnthropic client based on connection mode."""
    import anthropic

    validate_credentials(settings, "anthropic")

    if getattr(settings, "connection_mode", "own_key") == "managed":
        proxy_url = getattr(settings, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL
        return anthropic.AsyncAnthropic(
            auth_token=getattr(settings, "openswarm_auth_token", None),
            base_url=proxy_url,
        )

    return anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
