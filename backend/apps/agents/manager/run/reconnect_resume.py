"""Keep a turn alive across an outage that outlasts the turn's own retry budget.

The in-turn ladder (CAPACITY_BACKOFFS) spends 335s and then gives up, which is the right call for
a blip. It is the wrong call for a closed lid, a switched network, a hotel captive portal or a
provider having a bad ten minutes: the user comes back to a task that stopped for a reason that was
never theirs, and has to retype it.

Nothing about that is unrecoverable. The transcript is already checkpointed, the tools that ran are
still recorded, and the continuation seam that the auth self-heal uses will pick the work back up
mid-task. So an outage becomes a wait on a widening schedule rather than an ending.

Two properties this deliberately keeps:
  - it is bounded (three rounds, then the honest pill), because a retry loop with no end is how you
    burn a user's quota on a provider that is genuinely gone;
  - the wait is PERSISTED, so quitting mid-wait leaves an owed turn that boot-restore resumes,
    instead of a task that evaporated while nobody was looking.
"""

import asyncio
import logging
from typing import Optional

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession

logger = logging.getLogger(__name__)

# Widening but short at the start: most outages are seconds, and a user should see it heal itself rather than learn to press a button.
RECONNECT_BACKOFFS = (60, 300, 900)

# A provider's own "reset after" hint outranks our schedule, but capped, because a bad hint must not park a turn for an hour.
RECONNECT_MAX_DELAY_S = 1800

RECONNECT_PROMPT = (
    "The connection to the model dropped and has just come back. Continue exactly where you left "
    "off; do not redo completed steps."
)


@typechecked
def arm_reconnect_resume(session: AgentSession, retry_after_s: Optional[int] = None,
                         connection_lost: bool = False) -> Optional[int]:
    """Park the turn and queue one more attempt. Returns the delay armed, or None when the budget
    is spent and the caller should surface the honest pill instead.

    Retrying the work IS the connectivity test, so there is no separate reachability oracle to get
    wrong: either the next attempt goes through, or it fails and buys the next (longer) round.
    """
    if session.pending_continuation:
        return None
    attempts = int(getattr(session, "reconnect_attempts", 0) or 0)
    if attempts >= len(RECONNECT_BACKOFFS):
        return None

    delay = RECONNECT_BACKOFFS[attempts]
    if retry_after_s and retry_after_s > 0:
        delay = max(delay, min(int(retry_after_s) + 5, RECONNECT_MAX_DELAY_S))

    session.reconnect_attempts = attempts + 1
    session.awaiting_reconnect = True
    # Only a dead transport leaves the CLI holding a corpse; a 429 is a healthy pipe carrying a NO, and respawning for that spends a process to be told the same thing. The new process resumes the same transcript.
    if connection_lost:
        session.needs_respawn = True
    session.pending_continuation = True
    session.pending_continuation_prompt = RECONNECT_PROMPT
    session.pending_continuation_delay_s = delay
    return delay


@typechecked
def clear_reconnect_wait(session: AgentSession) -> None:
    """A turn that got through ends the outage: drop the parked flag so a later, unrelated blip
    starts from a full budget rather than inheriting this one's."""
    session.awaiting_reconnect = False


# How often to look while parked: short enough that a wifi blip costs seconds, long enough to stay cheap over a 15 minute outage.
RECONNECT_POLL_S = 3

# The probe must be fast: a hung connect would turn "check every 3s" into "check whenever the socket gives up".
RECONNECT_PROBE_TIMEOUT_S = 1.5


@typechecked
def provider_probe_host(session: AgentSession) -> str:
    """The host whose reachability actually decides whether a retry can succeed.

    Router-backed lanes point the CLI at localhost, so probing THAT would come back healthy while
    the machine is offline, which is the wrong answer at the only moment it matters. Probe the
    provider the router is proxying to instead.
    """
    p_model = (getattr(session, "model", "") or "").lower()
    if p_model.startswith(("cx/", "gpt-")) or "openai" in p_model:
        return "api.openai.com"
    if p_model.startswith(("gc/", "ag/", "gemini")) or "gemini" in p_model:
        return "generativelanguage.googleapis.com"
    return "api.anthropic.com"


@typechecked
async def provider_reachable(host: str) -> bool:
    """True when a TCP connection to the provider completes. Deliberately not an HTTP request: no
    auth, no cost, no quota, and nothing that a retry would have spent anyway."""
    try:
        p_fut = asyncio.open_connection(host, 443)
        reader, writer = await asyncio.wait_for(p_fut, timeout=RECONNECT_PROBE_TIMEOUT_S)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False


@typechecked
async def wait_for_reconnect(session: AgentSession, ceiling_s: int) -> None:
    """Sleep until the provider answers again, or until the ceiling, whichever comes FIRST.

    The backoff is a bound on patience, never a fixed sentence: a blind sleep would leave a user
    watching a spinner for fourteen more minutes after their wifi already came back, which is worse
    than the button it replaced. A captive portal can still answer TCP and fail the real request;
    that costs one round and lands us exactly where a blind wait would have been anyway.
    """
    p_host = provider_probe_host(session)
    p_waited = 0
    while p_waited < ceiling_s:
        p_step = min(RECONNECT_POLL_S, ceiling_s - p_waited)
        await asyncio.sleep(p_step)
        p_waited += p_step
        if await provider_reachable(p_host):
            logger.info(f"reconnect: {p_host} answered after {p_waited}s (ceiling was {ceiling_s}s)")
            return
    logger.info(f"reconnect: ceiling {ceiling_s}s reached without {p_host} answering; trying anyway")
