"""Drop a subscription provider's 9Router lane and report only what actually happened.

Deleting is the easy half; honesty is the hard half. 9Router answers a bad id with a 404 and a JSON
error body, so a caller that ignores status codes reports "disconnected" for a lane that is still
live, and the user reconnects on top of a stale row. So success here is verified, never inferred:
`ok` means the provider has no connection row left, confirmed by re-reading 9Router.
"""

import logging
from typing import Dict, List, Optional

import httpx
from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.nine_router.process import NINE_ROUTER_API, cli_auth_headers, is_running
from backend.apps.nine_router.subscription_health import invalidate_health_cache

logger = logging.getLogger(__name__)

# gemini-cli and antigravity are two Google OAuth lanes; the registry prefers AG, so dropping gemini-cli must drop the stale AG row too or it 400s. One-directional: AG operations MUST NOT cascade back.
PROVIDER_CASCADE_REMOVES: Dict[str, List[str]] = {
    "gemini-cli": ["antigravity"],
}

P_TIMEOUT_S = 10.0


class SubscriptionDisconnectResult(BaseModel):
    """What the user may be told: `ok` only once the lane is verifiably empty."""

    model_config = ConfigDict(validate_assignment=True)
    ok: bool
    removed: int = 0
    error: str = ""


@typechecked
def sync_settings_state() -> None:
    """Push the settings snapshot to the cloud state sync, exactly as connecting does. Imported late: service.client reaches back into this package."""
    from backend.apps.service.client import sync
    from backend.apps.settings.redaction import redact_settings
    from backend.apps.settings.settings import load_settings
    # F1: credentials never leave the machine through the telemetry/state sync; every sync site redacts first.
    sync(redact_settings(load_settings().model_dump()))


@typechecked
async def p_list_connections() -> Optional[List[Dict]]:
    """Every 9Router connection row, or None when the router can't be read.

    Deliberately not `nine_router.get_providers`, which folds an unreachable router into an empty
    list: here "I couldn't look" and "nothing is connected" must not be the same answer.
    """
    try:
        async with httpx.AsyncClient(timeout=P_TIMEOUT_S, headers=cli_auth_headers()) as client:
            r = await client.get(f"{NINE_ROUTER_API}/providers")
            if r.status_code != 200:
                return None
            data = r.json()
            if not isinstance(data, dict):
                return None
            return data.get("connections") or []
    except Exception as e:
        logger.debug(f"9Router provider list failed: {e}")
        return None


@typechecked
async def delete_provider_connections(providers: List[str]) -> int:
    """Delete every 9Router connection belonging to `providers`; returns how many really went."""
    connections = await p_list_connections()
    if connections is None:
        return 0
    removed = 0
    async with httpx.AsyncClient(timeout=P_TIMEOUT_S, headers=cli_auth_headers()) as client:
        for c in connections:
            if c.get("provider") not in providers or not c.get("id"):
                continue
            try:
                r = await client.delete(f"{NINE_ROUTER_API}/providers/{c['id']}")
                if r.status_code < 400:
                    removed += 1
                else:
                    logger.warning(f"9Router refused to drop the {c.get('provider')} connection: HTTP {r.status_code}")
            except Exception as e:
                logger.warning(f"9Router delete failed for {c.get('provider')}: {e}")
    return removed


@typechecked
async def disconnect_subscription(provider: str) -> SubscriptionDisconnectResult:
    """Clear `provider` (and its cascade lanes) from 9Router, confirming the lane is gone."""
    if not is_running():
        return SubscriptionDisconnectResult(ok=False, error="The subscription service isn't running.")

    targets = [provider, *PROVIDER_CASCADE_REMOVES.get(provider, [])]
    removed = await delete_provider_connections(targets)

    remaining = await p_list_connections()
    if remaining is None:
        return SubscriptionDisconnectResult(
            ok=False, removed=removed, error="Couldn't confirm the disconnect. Please try again.",
        )
    if any(c.get("provider") in targets for c in remaining):
        return SubscriptionDisconnectResult(
            ok=False, removed=removed, error="The subscription service kept the connection. Please try again.",
        )

    sync_settings_state()
    # A deliberate disconnect makes the cached boot verdict a lie: it would nag "reconnect" about the lane the user just dropped.
    invalidate_health_cache()
    return SubscriptionDisconnectResult(ok=True, removed=removed)
