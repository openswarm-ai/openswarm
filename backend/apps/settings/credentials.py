"""Resolve LLM credentials for the configured provider."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import anthropic
    from backend.apps.settings.models import AppSettings

OPENSWARM_DEFAULT_PROXY_URL = "https://api.openswarm.com"

# Connection modes that route Claude traffic through our cloud proxy with a
# bearer instead of a user-held key. Free-trial is openswarm-pro's cheaper
# sibling: same proxy, but pointed at the /free sub-path the cloud meters and
# forces to Haiku.
PROXY_CONNECTION_MODES = ("openswarm-pro", "free-trial")


def proxy_auth(settings: AppSettings) -> tuple[str | None, str | None]:
    """(auth_token, base_url) for whichever cloud-proxy mode is active, else
    (None, None). Consumers append /v1/messages to base_url as usual; for
    free-trial the base carries the /free segment so the same SDK lands on the
    metered route."""
    mode = getattr(settings, "connection_mode", "own_key")
    base = (getattr(settings, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL).rstrip("/")
    if mode == "openswarm-pro":
        return (getattr(settings, "openswarm_bearer_token", None), base)
    if mode == "free-trial":
        return (getattr(settings, "free_trial_token", None), base + "/free")
    return (None, None)


def _check_9router() -> bool:
    """Check if 9Router is running locally."""
    try:
        import httpx
        r = httpx.get("http://localhost:20128/v1/models", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False

def get_anthropic_client(settings: AppSettings) -> anthropic.AsyncAnthropic:
    """Return an AsyncAnthropic client for the user's current connection mode."""
    import anthropic

    if getattr(settings, "connection_mode", "own_key") in PROXY_CONNECTION_MODES:
        token, base = proxy_auth(settings)
        return anthropic.AsyncAnthropic(
            auth_token=token,
            base_url=base or OPENSWARM_DEFAULT_PROXY_URL,
        )

    # Prefer the user's own API key when present.
    if settings.anthropic_api_key:
        return anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    # Fall back to 9Router (free for users with Claude/ChatGPT/Gemini subscriptions).
    if _check_9router():
        return anthropic.AsyncAnthropic(
            api_key="9router",
            base_url="http://localhost:20128",
        )

    raise ValueError("No AI provider configured. Set an API key or connect a subscription.")


def get_anthropic_client_for_model(settings: AppSettings, api_model: str) -> anthropic.AsyncAnthropic:
    """Route 9Router-prefixed models (cc/, cx/, gc/, cp-) straight to 9Router so user subscriptions reach their own accounts."""
    import anthropic
    if isinstance(api_model, str) and (
        api_model.startswith(("cc/", "cx/", "gc/")) or api_model.startswith("cp-")
    ):
        return anthropic.AsyncAnthropic(
            api_key="9router",
            base_url="http://localhost:20128",
        )
    return get_anthropic_client(settings)
