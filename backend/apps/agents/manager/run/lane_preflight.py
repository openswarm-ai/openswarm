"""Do not spend a user's turn on a lane we already know is dead... and never restart the router for it.

Live drill, 2026-08-20: a codex credential that expired 89 HOURS earlier produced "GPT subscription
token just rotated (automatic, every couple minutes), retrying automatically, no action needed", a
75 second wait, a doomed retry, and then five identical cards. Zero files read. The evidence to know
better was already in 9Router's own provider list: `testStatus: "unavailable"` with `errorCode: 401`.

What this does with it:

  healthy      -> say nothing, cost nothing, dispatch as normal
  dead         -> DISPATCH ANYWAY, and flag the session so that if the turn really does 401,
                  handle_run_error says the accurate sentence with no rotation story, and the
                  dead-login recheck pushes the reconnect pill.

What it deliberately does NOT do any more (2026-09-06): restart the router. A restart cannot revive
a dead token; it is a dead port for every chat on every lane for 1 to 30 s (ENG-394's shape); and the
one thing it did fix, stale router memory after the user reconnected, is bounce_after_connect's job on
the reconnect path. The router's "unavailable" is a timed cooldown it clears on its own.

This file NEVER tells the user a credential is dead, because it has not dispatched and therefore
cannot know (ENG-414: a throttle read as death grounded a working lane). Only a real failed dispatch
may say that.
"""

import logging
from typing import Dict, Optional, TYPE_CHECKING

from typeguard import typechecked

if TYPE_CHECKING:
    from backend.apps.agents.core.models import AgentSession

logger = logging.getLogger(__name__)

# Router prefix -> the provider name its connection is filed under.
P_PREFIX_PROVIDER = {"cc/": "claude", "cx/": "codex", "gc/": "antigravity", "ag/": "antigravity"}


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
    """A credential that needs the USER, as opposed to one having a bad minute.

    Only auth-shaped failures qualify. `testStatus: "unavailable"` alone does NOT: the router
    stamps it for rate limits and upstream 5xx too, and a live 2026-08-20 run proved the cost of
    conflating them, telling Eric to reconnect a Google account whose credential was valid for
    another half hour and merely 429'd. Advising a reconnect for a throttle is the same lie as
    "just rotated" for a dead token, pointing the other way, so the bar here is evidence that
    waiting cannot help: 401 or 403.

    And the 401 has to be the router's CURRENT verdict: 0.3.60 leaves `errorCode: 401` on a row it has
    since marked `testStatus: "active"` (Eric's claude row carried it while serving 424 requests on
    2026-09-05), so errorCode alone read a healthy lane as dead and asked for a router bounce at
    every turn start.
    """
    return conn.get("errorCode") in (401, 403) and conn.get("testStatus") == "unavailable"


# The shape the router publishes for a credential it has given up on, and the shape a drill injects.
# It is built to satisfy `connection_is_dead` above, and a test pins that, so a drill can never fire
# a fault the guard ignores and still report a pass.
def injected_dead_conn(provider: str) -> Dict:
    return {"provider": provider, "testStatus": "unavailable", "errorCode": 401}


async def dead_connection(provider: str) -> Optional[Dict]:
    """The provider's connection if the router considers it dead, else None. Never raises: a preflight that cannot read health must let the turn proceed, because guessing "dead" would ground a working lane."""
    from backend.apps.agents.core.fault_injection import armed as p_fault_armed
    if p_fault_armed("dead_lane"):
        logger.warning("[fault] dead_lane armed: reporting %s as a dead credential", provider)
        return injected_dead_conn(provider)
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
    if session is not None:
        try:
            session.lane_provider = provider
        except Exception:
            pass
    if provider is None:
        return None

    dead = await dead_connection(provider)
    # Written on EVERY pass, both directions. It used to be latched True and never cleared, so one
    # blip made every later auth error in that session claim a permanently dead credential.
    if session is not None:
        try:
            session.lane_credential_dead = dead is not None
        except Exception:
            pass
    if dead is None:
        return None
    # No restart here. A router bounce cannot revive a dead token, and it is a dead port for 1 to 30 s for
    # EVERY chat on every lane (the ENG-394 shape) while this lane's own failure was going to be reported
    # anyway. The one case a restart fixes, stale router memory after the user reconnected, has its own
    # restart on the reconnect path (bounce_after_connect), and the router's "unavailable" is a timed
    # cooldown it clears itself. Dispatch is the test: a dead credential 401s, the flag above makes that
    # card honest at once, and the health recheck pushes the reconnect pill.
    logger.warning(
        f"lane preflight: {provider} reads dead in the router (testStatus={dead.get('testStatus')}, "
        f"errorCode={dead.get('errorCode')}); dispatching so the real request decides, no restart"
    )
    return None
