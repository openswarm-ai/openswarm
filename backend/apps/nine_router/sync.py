"""Provider API-key sync into 9Router.

Mirrors the user's stored Gemini / OpenAI / OpenRouter keys into 9Router
as OpenSwarm-managed apikey connections. Talks to the already-running
9Router over HTTP; never spawns the subprocess (that's process.py's job).
"""

import logging

from .process import NINE_ROUTER_API

logger = logging.getLogger(__name__)


def _nr():
    """The package module. is_running / get_providers / httpx are read off it
    at call time so tests that patch `backend.apps.nine_router.<name>` still
    take effect after the split (they used to all live on one module)."""
    from backend.apps import nine_router
    return nine_router

# API-key auth (provider="gemini", authType="apikey") and OAuth hit different
# Google quotas: OAuth uses the Code Assist free tier (aggressively rate-limited;
# 429s on Gemini 3 Pro/Flash even for paid users), while an AI Studio API key
# uses generativelanguage.googleapis.com (independent and far higher). We mirror
# google_api_key into 9Router so the API-key path is preferred when a key is set.

NINE_ROUTER_KEYED_NAME = "AI Studio (OpenSwarm-managed)"
NINE_ROUTER_OPENAI_KEYED_NAME = "OpenAI (OpenSwarm-managed)"
NINE_ROUTER_OPENROUTER_KEYED_NAME = "OpenRouter (OpenSwarm-managed)"
NINE_ROUTER_CLAUDE_PRO_NAME = "OpenSwarm Pro (OpenSwarm-managed)"

# Reserved prefix that registry.py's gpt-5.*-api router_model_ids depend on.
# Changing this breaks model resolution for OpenAI own-key users.
NINE_ROUTER_OPENAI_KEYED_PREFIX = "cp-openai"


async def _find_keyed_connection(provider: str, name: str) -> dict | None:
    """Return the 9Router connection we manage for this provider, if any."""
    conns = await _nr().get_providers()
    if not isinstance(conns, list):
        return None
    for c in conns:
        if (
            isinstance(c, dict)
            and c.get("provider") == provider
            and c.get("authType") == "apikey"
            and c.get("name") == name
        ):
            return c
    return None


async def _sync_apikey_provider(
    provider: str,
    api_key: str | None,
    name: str,
    *,
    label: str,
) -> None:
    """Create/update/delete an OpenSwarm-managed apikey connection. Silent if 9Router is down."""
    if not _nr().is_running():
        return

    existing = await _find_keyed_connection(provider, name)
    try:
        async with _nr().httpx.AsyncClient(timeout=5.0) as client:
            if api_key:
                payload = {
                    "provider": provider,
                    "authType": "apikey",
                    "name": name,
                    "apiKey": api_key,
                    # Priority 0 = highest. OAuth connections default to 1,
                    # so keyed connections are preferred when both exist.
                    "priority": 0,
                }
                if existing:
                    await client.patch(
                        f"{NINE_ROUTER_API}/providers/{existing['id']}",
                        json=payload,
                    )
                    logger.info(f"9Router: updated {label} API-key connection")
                else:
                    r = await client.post(f"{NINE_ROUTER_API}/providers", json=payload)
                    if r.status_code < 300:
                        logger.info(f"9Router: created {label} API-key connection")
                    else:
                        logger.warning(
                            f"9Router: failed to create {label} API-key connection: "
                            f"{r.status_code} {r.text[:200]}"
                        )
            else:
                if existing:
                    await client.delete(f"{NINE_ROUTER_API}/providers/{existing['id']}")
                    logger.info(f"9Router: removed {label} API-key connection")
    except Exception as e:
        logger.warning(f"9Router {label} API-key sync failed: {e}")


async def sync_gemini_api_key(api_key: str | None) -> None:
    """Mirror google_api_key into 9Router; bypasses Code Assist's tight quota."""
    await _sync_apikey_provider(
        "gemini", api_key, NINE_ROUTER_KEYED_NAME, label="Gemini"
    )


async def sync_openai_api_key(api_key: str | None) -> None:
    """Mirror openai_api_key into 9Router as an `openai-compatible` provider
    node pointed at our local /api/openai-passthrough proxy.

    Why not the built-in `openai` provider type: 9Router 0.3.60 hardcodes
    `https://api.openai.com/v1` for the `openai` provider and ignores any
    `baseUrl` field on the connection. Only the `openai-compatible-*`
    provider-node type honors `baseUrl` (verified statically against
    9Router's compiled bundle). So we register our OpenAI lane AS an
    openai-compatible node; same upstream protocol, different routing.

    Why we route through openai-passthrough at all: OpenAI's GPT-5 family
    rejects the legacy `max_tokens` parameter with HTTP 400, but every
    9Router version (including 0.4.20) emits `max_tokens` in its
    Anthropic→OpenAI translator. The passthrough renames it to
    `max_completion_tokens` for `gpt-5*` models before forwarding to
    api.openai.com. Pre-fix: every gpt-5.* own-key session 400'd silently.

    Companion change: the registry entries `gpt-5.*-api` are routed via
    the `cp-openai/<model>` prefix (set by NINE_ROUTER_OPENAI_KEYED_PREFIX
    above) so 9Router's translator dispatches to this provider-node
    instead of the built-in `openai` provider.
    """
    from .sync_custom import _sync_openai_compat_node
    await _sync_openai_compat_node(api_key)


async def sync_openrouter_api_key(api_key: str | None) -> None:
    """Mirror openrouter_api_key into 9Router; supplies bearer for openrouter/ routes."""
    await _sync_apikey_provider(
        "openrouter", api_key, NINE_ROUTER_OPENROUTER_KEYED_NAME, label="OpenRouter"
    )
