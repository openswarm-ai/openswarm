"""A browser agent stuck on a hard login wall, with no session to borrow, used to just keep
failing at the wall; the one thing that fixes it is the human signing in, and the browser card is
RIGHT THERE to do it in. So: pause the model loop and watch the page until the wall clears, then
resume automatically (ENG-279). This must never fire RequestHumanIntervention (Eric's call,
2026-08-08: auto-injected interventions made workflows impossible to run unattended), which is why
it is a backend poll with a hard deadline, not a HITL tool: an unattended run stalls at most
MAX_WAIT_SECONDS and then continues with an honest note."""

import asyncio
import logging
from typing import Awaitable, Callable, Tuple

from typeguard import typechecked

from backend.apps.agents.browser import browser_login_handoff

logger = logging.getLogger(__name__)

POLL_SECONDS = 4.0
MAX_WAIT_SECONDS = 180.0
# One clear poll can be an OAuth redirect mid-flight (interstitial URL that matches no wall);
# require two in a row so the resume note only fires once the destination page is really back.
CLEAR_POLLS_NEEDED = 2


@typechecked
async def wait_for_user_signin(
    domain: str,
    probe: Callable[[], Awaitable[Tuple[str, str]]],
    cancel_event: asyncio.Event,
) -> bool:
    """Poll the page until the login wall for `domain` clears. `probe` returns the page's current
    (url, visible_text). True = the user signed in (two consecutive wall-free polls); False =
    deadline, cancellation, or probe failure. Never raises."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + MAX_WAIT_SECONDS
    clear_streak = 0
    while loop.time() < deadline:
        if cancel_event.is_set():
            return False
        try:
            await asyncio.wait_for(cancel_event.wait(), timeout=POLL_SECONDS)
            return False
        except asyncio.TimeoutError:
            pass
        try:
            url, text = await probe()
        except Exception:
            clear_streak = 0
            continue
        if not url:
            clear_streak = 0
            continue
        if browser_login_handoff.login_wall_domain(url, text) is None:
            clear_streak += 1
            if clear_streak >= CLEAR_POLLS_NEEDED:
                logger.info(f"[signin-wait] wall on {domain} cleared by the user")
                return True
        else:
            clear_streak = 0
    logger.info(f"[signin-wait] {domain} still walled after {int(MAX_WAIT_SECONDS)}s; continuing without")
    return False
