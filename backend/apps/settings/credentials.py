"""Resolve LLM credentials for the configured provider."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import anthropic
    from backend.apps.settings.models import AppSettings

OPENSWARM_DEFAULT_PROXY_URL = "https://api.openswarm.com"

# Connection modes that route Claude traffic through our cloud proxy with a bearer instead of a user-held key. Free-trial is openswarm-pro's cheaper sibling: same proxy, but pointed at the /free sub-path the cloud meters and forces to Haiku.
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


def account_auth(settings: AppSettings) -> tuple[str | None, str]:
    """(bearer, base_url) for cloud routes that identify the ACCOUNT rather than
    route LLM traffic: publishing, hosted workflows, anything behind the cloud's
    requireAuthedUser. Deliberately ignores connection_mode, because a signed-in
    own-key user still has a real account. Bearer is None when signed out."""
    base = (getattr(settings, "openswarm_proxy_url", None) or OPENSWARM_DEFAULT_PROXY_URL).rstrip("/")
    return (getattr(settings, "openswarm_bearer_token", None) or None, base)


def p_check_9router() -> bool:
    """Check if 9Router is running locally."""
    try:
        import httpx
        r = httpx.get("http://localhost:20128/v1/models", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False


def validate_credentials(settings: AppSettings, provider: str = "anthropic") -> None:
    """Raise ValueError if the provider has no usable credentials."""
    p = provider.lower().strip()

    # 9Router handles its own credentials.
    if p == "9router":
        return

    # 9Router proxies every provider, so if it's up we don't need keys here.
    if p_check_9router():
        return

    if p == "anthropic":
        if getattr(settings, "connection_mode", "own_key") in PROXY_CONNECTION_MODES:
            token, _ = proxy_auth(settings)
            if not token:
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
        # These providers route through OpenRouter, so its key is required.
        if getattr(settings, "openrouter_api_key", None):
            return
        raise ValueError(f"{provider} requires an OpenRouter API key, or connect a subscription via 9Router.")
    else:
        for cp in getattr(settings, "custom_providers", []):
            if cp.name.lower() == p:
                return
        # Let create_provider raise for unknown providers; not our job here.
        return


def get_provider_credentials(settings: AppSettings, provider: str) -> dict[str, str]:
    """Return the credential dict for the given provider."""
    p = provider.lower().strip()
    validate_credentials(settings, provider)

    if p in ("anthropic", "claude"):
        if getattr(settings, "connection_mode", "own_key") in PROXY_CONNECTION_MODES:
            token, base = proxy_auth(settings)
            return {
                "auth_token": token or "",
                "base_url": base or OPENSWARM_DEFAULT_PROXY_URL,
            }
        return {"api_key": settings.anthropic_api_key or ""}

    if p in ("openai", "codex"):
        return {"api_key": settings.openai_api_key or ""}

    if p in ("gemini", "google", "gemini-cli"):
        return {"api_key": getattr(settings, "google_api_key", "") or ""}

    if p == "openrouter":
        return {"api_key": getattr(settings, "openrouter_api_key", "") or ""}

    for cp in getattr(settings, "custom_providers", []):
        if cp.name.lower() == p:
            # Local OpenAI-compatible servers (LM Studio, Ollama) ignore the key; placeholder keeps downstream callers happy.
            key = (cp.api_key or "").strip() or "no-auth-required"
            return {"api_key": key, "base_url": cp.base_url}

    raise ValueError(f"No credentials for provider: {provider}")


def anthropic_workspace_header(settings: AppSettings) -> dict[str, str]:
    """Anthropic's identity-linked keys (personal and service-account) can span workspaces; such a key
    must say which workspace every request acts in or the API answers 400 before the model is reached."""
    workspace = (getattr(settings, "anthropic_workspace_id", None) or "").strip()
    return {"anthropic-workspace-id": workspace} if workspace else {}


def own_key_anthropic_client(settings: AppSettings) -> anthropic.AsyncAnthropic:
    """The user's own Anthropic key as an SDK client. Every aux call on the key lane builds its client
    here, so the workspace header cannot be present on one door and missing on another."""
    import anthropic

    return anthropic.AsyncAnthropic(
        api_key=settings.anthropic_api_key,
        default_headers=anthropic_workspace_header(settings) or None,
    )


def own_key_cli_env(settings: AppSettings) -> dict[str, str]:
    """The user's own Anthropic key as the CLI's env. ANTHROPIC_CUSTOM_HEADERS is the CLI's documented
    way to add a request header; a key with no workspace id gets exactly the env it always did."""
    env = {"ANTHROPIC_API_KEY": settings.anthropic_api_key or ""}
    header = anthropic_workspace_header(settings)
    if header:
        env["ANTHROPIC_CUSTOM_HEADERS"] = "\n".join(f"{name}: {value}" for name, value in header.items())
    return env


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
        return own_key_anthropic_client(settings)

    # Fall back to 9Router (free for users with Claude/ChatGPT/Gemini subscriptions).
    if p_check_9router():
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
