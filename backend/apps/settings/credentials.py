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


def _check_9router() -> bool:
    """Check if 9Router is running locally."""
    try:
        import httpx
        r = httpx.get("http://localhost:20128/v1/models", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False


def validate_credentials(settings: AppSettings, provider: str = "anthropic") -> None:
    """Raise ValueError if credentials are missing for the given provider.

    Allows through if 9Router is running as a fallback.
    Handles both display names ('Anthropic') and lowercase ('anthropic').
    """
    p = provider.lower().strip()

    # 9Router or GitHub Copilot providers don't need traditional credentials
    if p in ("9router", "github copilot", "copilot"):
        return

    # If 9Router is running, all providers are accessible
    if _check_9router():
        return

    if p == "anthropic":
        if getattr(settings, "connection_mode", "own_key") == "managed":
            if not getattr(settings, "openswarm_auth_token", None):
                raise ValueError("Open Swarm account not connected. Sign in via Settings -> API.")
            return
        if settings.anthropic_api_key:
            return
        raise ValueError("Anthropic API key not configured. Set it in Settings, or connect a subscription.")
    elif p == "openai":
        if settings.openai_api_key:
            return
        raise ValueError("OpenAI API key not configured. Set it in Settings, or connect a subscription.")
    elif p in ("gemini", "google"):
        if getattr(settings, "google_api_key", None):
            return
        raise ValueError("Google API key not configured. Set it in Settings, or connect a subscription.")
    elif p == "openrouter":
        if getattr(settings, "openrouter_api_key", None):
            return
        raise ValueError("OpenRouter API key not configured. Set it in Settings.")
    elif p in ("xai", "meta", "deepseek", "mistral", "qwen", "cohere"):
        # These route through OpenRouter — need either OpenRouter key or 9Router
        if getattr(settings, "openrouter_api_key", None):
            return
        raise ValueError(f"{provider} requires an OpenRouter API key, or connect a subscription via 9Router.")
    else:
        # Custom provider — check if it exists in custom_providers
        for cp in getattr(settings, "custom_providers", []):
            if cp.name.lower() == p:
                return
        # Unknown provider — allow through (create_provider will handle the error)
        return


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
