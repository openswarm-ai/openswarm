"""Did the run change anything out there? Answered as a value the caller can branch on.

Haik, production 1.7.9, on a playlist edit: "Zero-confidence outcomes on a write path is the worst
possible spot to leave an agent in: I'm forced to choose between doing nothing and risking a
double-write." Our honesty gate was right to refuse to claim the send happened; what it gave back
was prose, so a parent agent could not tell "definitely did not happen" from "cannot tell" and had
no basis to decide between stalling and retrying (ENG-402).

Fail-safe by construction: the read-only set is an ALLOWLIST, and anything not on it is assumed to
have changed something. A browser tool added tomorrow reads as UNKNOWN rather than as harmless.
"""

from typing import Dict, List, Literal

from typeguard import typechecked

from backend.apps.agents.browser.browser_loop import READ_ONLY_TOOLS

Disposition = Literal["applied", "none", "unknown"]

NOTHING_HAPPENED = "none"
MAY_HAVE_HAPPENED = "unknown"
CONFIRMED = "applied"


@typechecked
def effect_disposition(action_log: List[Dict], send_confirmed: bool = False) -> Disposition:
    """Whether anything left this machine, given what the run actually called.

    "applied" needs positive proof, not a tool that returned ok: a click reporting success is not
    evidence the write landed, which is the precise gap that told a user "Done, I sent it for you"
    while the post never arrived.
    """
    p_changing = [a for a in action_log or [] if str(a.get("tool") or "") not in READ_ONLY_TOOLS]
    if not p_changing:
        return NOTHING_HAPPENED
    if send_confirmed:
        return CONFIRMED
    return MAY_HAVE_HAPPENED


@typechecked
def disposition_line(disposition: Disposition) -> str:
    """One sentence telling the caller what it is safe to do next."""
    if disposition == NOTHING_HAPPENED:
        return ("Nothing was changed on the page, so this is safe to retry.")
    if disposition == CONFIRMED:
        return ("The change was confirmed on the page, so do not repeat it.")
    return ("A change was attempted and could not be confirmed, so this may or may not have gone "
            "through. Read the page and check before retrying; repeating it blind risks doing it "
            "twice.")
