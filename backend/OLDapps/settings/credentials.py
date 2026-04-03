"""Centralized credential resolution for LLM API calls.

Supports multiple providers: Anthropic (native), OpenAI, Gemini,
OpenRouter, and user-configured custom providers.
"""

from __future__ import annotations

import httpx
from backend.ports import NINE_ROUTER_PORT
import anthropic
from backend.apps.settings.models import AppSettings

OPENSWARM_DEFAULT_PROXY_URL = "https://api.openswarm.ai"


def _check_9router() -> bool:
    """Check if 9Router is running locally."""
    try:
        r = httpx.get(f"http://localhost:{NINE_ROUTER_PORT}/v1/models", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False

# ---------------------------------------------------------------------------
# Legacy helpers (kept for backward compat during migration)
# ---------------------------------------------------------------------------

def get_anthropic_client(settings: AppSettings) -> anthropic.AsyncAnthropic:
    """Return a configured AsyncAnthropic client based on connection mode.

    Priority: managed mode → 9Router subscription → API key
    """

    if getattr(settings, "connection_mode", "own_key") == "managed":
        proxy_url = getattr(settings, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL
        return anthropic.AsyncAnthropic(
            auth_token=getattr(settings, "openswarm_auth_token", None),
            base_url=proxy_url,
        )

    # Prefer API key when set
    if settings.anthropic_api_key:
        return anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    # Fall back to 9Router subscription (free for users with Claude/ChatGPT/Gemini subscriptions)
    if _check_9router():
        return anthropic.AsyncAnthropic(
            api_key="9router",
            base_url=f"http://localhost:{NINE_ROUTER_PORT}",
        )

    raise ValueError("No AI provider configured. Set an API key or connect a subscription.")
