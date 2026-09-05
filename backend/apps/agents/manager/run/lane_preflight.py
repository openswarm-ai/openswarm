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
  sticky-dead, bounce
  already throttled  -> DISPATCH ANYWAY too, and flag the session so that if the turn really does
                        401, handle_run_error can say the accurate sentence with no rotation story.

This file NEVER tells the user a credential is dead, because it has not dispatched and therefore
cannot know. It used to, off the bounce cooldown, and that cooldown is a GLOBAL router-restart
throttle: the branch that meant "permanently dead" actually meant "another chat restarted the
router in the last five minutes". It killed a live build on a working credential while telling the
user "waiting will not clear this one", which was backwards, since waiting out the throttle is
exactly what cleared it (ENG-414). The death verdict lives in ONE place now, downstream of a real
failed dispatch.

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

    now = time.time()
    if now - LAST_BOUNCE.get(provider, 0.0) >= BOUNCE_COOLDOWN_S:
        LAST_BOUNCE[provider] = now
        logger.warning(
            f"lane preflight: {provider} is {dead.get('testStatus')} (errorCode={dead.get('errorCode')}); "
            "bouncing the router once, then letting the turn decide"
        )
        p_back_up = False
        try:
            from backend.apps.nine_router.bounce_after_connect import bounce_router_after_connect
            p_back_up = await bounce_router_after_connect(provider)
        except Exception:
            logger.debug("lane preflight bounce failed", exc_info=True)
        if not p_back_up:
            # Dispatching into a router that has not come back is a guaranteed connection error, and
            # the user would read that as the model failing rather than us restarting something.
            logger.warning("lane preflight: the router did not come back after the bounce; not dispatching into it")
            return ("The local AI connection is restarting. This clears itself in a few seconds; "
                    "send your message again.")
        # Deliberately no post-bounce health re-read: see the module docstring. Dispatch is the test.
        return None

    # The bounce was throttled, and that says NOTHING about this credential: LAST_BOUNCE is global,
    # so the timer belongs to whichever OTHER chat restarted the router last. Carding here declared
    # a working lane dead and killed a live build (ENG-414), and it broke this file's own rule that
    # only a real dispatch can decide. So dispatch. If the credential really is gone, the turn 401s
    # and handle_run_error shows the accurate card immediately off `lane_credential_dead`, which is
    # the same sentence this used to return, minus the guessing.
    logger.info(
        f"lane preflight: {provider} looks dead but the router bounce is throttled; dispatching "
        "anyway and letting the turn decide"
    )
    return None
