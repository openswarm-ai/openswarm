"""Do not spend a user's turn on a lane we already know is dead.

Live drill, 2026-08-20: a codex credential that expired 89 HOURS earlier produced "GPT subscription
token just rotated (automatic, every couple minutes), retrying automatically, no action needed", a
75 second wait, a doomed retry, and then five identical cards. Zero files read. Every word of that
was wrong, and the evidence to know better was already sitting in 9Router's own provider list:
`testStatus: "unavailable"` with `errorCode: 401`, published before we spend anything.

So this looks first, and it tries to fix it before it complains:

  healthy            -> say nothing, cost nothing, dispatch as normal
  sticky-dead, first -> bounce the router ONCE (re-reads db.json, clears the in-process
                        `unavailable` stamp and modelLock cooldowns), then DISPATCH ANYWAY and let
                        the turn itself be the verdict. If it goes through, the user never learns
                        anything happened.
  sticky-dead, again -> one accurate sentence, immediately. No invented rotation window, no wait
                        the user has already tried by hand, no promise of a self-heal that cannot
                        happen.

The bounce is NOT allowed to declare success on its own, and that mistake is worth recording: the
first version re-read the health flag afterwards and called a cleared stamp a recovery. But a fresh
router starts with no stamp, so the check passed for a credential that was still dead, and the turn
hit the same 401 seconds later. A restart clears the accusation, not the cause. Only a real
dispatch can tell you whether a credential works, so that is what decides it now.

The bounce is the same one ENG-315 already runs at the connect chokepoint, and is documented safe
mid-session; the in-flight kill drill on 2026-08-20 confirmed a live turn survives one.
"""

import logging
import time
from typing import Dict, Optional, TYPE_CHECKING

from typeguard import typechecked

if TYPE_CHECKING:
    from backend.apps.agents.core.models import AgentSession

logger = logging.getLogger(__name__)

# Router prefix -> the provider name its connection is filed under.
P_PREFIX_PROVIDER = {"cc/": "claude", "cx/": "codex", "gc/": "antigravity", "ag/": "antigravity"}

# A bounce restarts a process every other session shares, so one per lane per window, never per turn.
BOUNCE_COOLDOWN_S = 300

LAST_BOUNCE: Dict[str, float] = {}

RECONNECT_COPY = {
    "codex": ("Your ChatGPT subscription needs reconnecting: the saved sign-in expired and could "
              "not be renewed. Open Settings, then Models, and click Reconnect on the OpenAI / GPT "
              "row. Waiting will not clear this one."),
    "claude": ("Your Claude subscription needs reconnecting: the saved sign-in expired and could "
               "not be renewed. Open Settings, then Models, and click Reconnect on the Claude "
               "Pro / Max row. Waiting will not clear this one."),
    "antigravity": ("Your Google sign-in needs reconnecting: the saved credential expired and "
                    "could not be renewed. Open Settings, then Models, and reconnect the Google "
                    "row. Waiting will not clear this one."),
}


@typechecked
def provider_for_model(resolved_model: str) -> Optional[str]:
    """The router connection a resolved model id will dispatch through, or None when the call does not go through the router at all (direct API keys own their own errors)."""
    for prefix, provider in P_PREFIX_PROVIDER.items():
        if resolved_model.startswith(prefix):
            return provider
    return None


@typechecked
def connection_is_dead(conn: Dict) -> bool:
    """A connection the router has given up on. Deliberately narrow: only the states that mean a dispatch is guaranteed to fail, never a slow or merely idle one."""
    if conn.get("testStatus") == "unavailable":
        return True
    return conn.get("errorCode") in (401, 403)


async def dead_connection(provider: str) -> Optional[Dict]:
    """The provider's connection if the router considers it dead, else None. Never raises: a preflight that cannot read health must let the turn proceed, because guessing "dead" would ground a working lane."""
    try:
        from backend.apps.nine_router import get_providers
        for conn in await get_providers():
            if conn.get("provider") != provider:
                continue
            return conn if connection_is_dead(conn) else None
    except Exception:
        logger.debug("lane preflight could not read provider health; proceeding", exc_info=True)
    return None


async def preflight_lane(resolved_model: str,
                         session: Optional["AgentSession"] = None) -> Optional[str]:
    """None when the turn should proceed, or the sentence to show the user when it should not.

    Returning a message here is a decision NOT to spend the turn, which is only correct because the
    alternative was measured: a guaranteed 401, misleading copy, and a wait the user has already
    tried themselves.
    """
    provider = provider_for_model(resolved_model)
    if provider is None:
        return None

    dead = await dead_connection(provider)
    if dead is None:
        return None

    # Whatever happens next, an auth failure on THIS turn is a dead credential, not a rotation
    # window: the router had already given up before we sent anything.
    if session is not None:
        try:
            session.lane_credential_dead = True
        except Exception:
            pass

    now = time.time()
    if now - LAST_BOUNCE.get(provider, 0.0) >= BOUNCE_COOLDOWN_S:
        LAST_BOUNCE[provider] = now
        logger.warning(
            f"lane preflight: {provider} is {dead.get('testStatus')} (errorCode={dead.get('errorCode')}); "
            "bouncing the router once, then letting the turn decide"
        )
        try:
            from backend.apps.nine_router.bounce_after_connect import bounce_router_after_connect
            await bounce_router_after_connect(provider)
        except Exception:
            logger.debug("lane preflight bounce failed", exc_info=True)
        # Deliberately no post-bounce health re-read: see the module docstring. Dispatch is the test.
        return None

    return RECONNECT_COPY.get(
        provider,
        "This model's sign-in expired and could not be renewed. Reconnect it in Settings, then "
        "Models. Waiting will not clear this one.",
    )
