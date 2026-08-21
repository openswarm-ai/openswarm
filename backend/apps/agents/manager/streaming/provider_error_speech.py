"""A provider's error is never the agent's voice.

The handler upstream of this module recognised exactly one failure -- an expired auth token -- by
matching four hand-written phrasings. Everything else the provider ever said arrived in the `else`
branch and was rendered as the agent's own words. Measured across this machine's 1645 stored
sessions: 14 of 2049 assistant messages are raw provider errors wearing the agent's face, 11 from
Gemini and 3 from Claude. To the user that is indistinguishable from the agent giving up and
babbling, which is the shape Haik and Alex keep reporting.

Adding a fifth phrasing to that list would fix the 429 and leave the next status open, which is the
whack-a-mole tier CLAUDE.md tells us not to aim for. So key on STRUCTURE instead, per VERIFICATION.md
section 2 ("structural signal over string sniffing"). Both observed shapes carry a machine stamp
that model prose does not:

    API Error: Request rejected (429) · [antigravity/gemini-3-flash] [429]: Individual quota ...
    API Error: Unable to connect. Is the computer able to access the url?

The `API Error:` prefix is written by the CLI, and `[lane/model] [NNN]:` is written by 9router.
Neither is something a model emits while answering a question, and requiring the stamp at the START
of the message is what keeps the negative control alive: an agent that merely WRITES about a 429 it
saw in a log is prose, not an envelope, and must still reach the user as speech. That distinction is
section 5b -- a fix that silently removes the ability to discuss errors would be its own regression.

What this module does NOT do is decide what happens next. It reports what the provider said; the
caller decides whether to heal, park, or surface, because those paths already exist and a second
mechanism doing the same job is the ENG-252 mistake.
"""

import re
from typing import Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.agents.core.error_classify import is_content_policy_block

# Written by the CLI in front of anything upstream failed with.
P_ENVELOPE_PREFIX = "api error:"

# Anchored on the bracket-slash-bracket shape, not on lane names, so tomorrow's lane still matches.
P_ROUTER_STAMP = re.compile(r"\[[a-z0-9._-]+/[a-z0-9._-]+\]\s*\[(\d{3})\]", re.I)

# A bare status inside the envelope, e.g. "Request rejected (429)".
P_STATUS = re.compile(r"\((\d{3})\)|\b(4\d{2}|5\d{2})\b")

# "Resets in 125h40m51s" / "(reset after 2m)" / "(reset after 1m 56s)". Gemini sends BOTH in one
# envelope, and they mean different things: the first is when the subscription quota actually
# resets, the second is only the router's own retry hint. Reading whichever came first made the
# same 429 say "5 days, switch models" one turn and "2 minutes, do nothing" the next (packaged
# drill 2026-08-20, seven contradictory cards in one ask), so collect them all and trust the longest.
P_RESET = re.compile(
    r"reset(?:s)?\s+(?:in|after)\s+((?:\d+\s*[hms]\s*)+)", re.I
)

# Wording that means the plan itself is spent, not that we are going too fast. Waiting cannot fix it.
P_SUBSCRIPTION_SPENT = ("quota reached", "upgrade your subscription", "exceeded your quota",
                        "subscription limit", "plan limit")

AUTH = "auth"
QUOTA = "quota"
CONNECTION = "connection"
OVERLOADED = "overloaded"
POLICY = "policy"
UNKNOWN = "unknown"


class ProviderError(BaseModel):
    """What the provider said, normalised. `kind` drives the caller's choice of recovery."""

    model_config = ConfigDict(validate_assignment=True)

    kind: str
    # True when the provider said the PLAN is spent rather than that we are going too fast; the
    # reset window is unreliable for this (same condition, sometimes 5 days, sometimes 2 minutes).
    subscription_spent: bool
    status: Optional[int]
    lane: Optional[str]
    reset_seconds: Optional[int]
    raw: str


@typechecked
def parse_duration(blob: str) -> Optional[int]:
    """'125h40m51s' or '1m 56s' -> seconds. None when nothing parses."""
    total = 0
    found = False
    for value, unit in re.findall(r"(\d+)\s*([hms])", blob, re.I):
        found = True
        n = int(value)
        total += n * {"h": 3600, "m": 60, "s": 1}[unit.lower()]
    return total if found else None


@typechecked
def looks_like_provider_envelope(text: str) -> bool:
    """True only for machine-stamped error envelopes, never for prose that discusses one.

    The stamp must open the message. An agent writing "the API returned 429, so I waited" carries
    the same vocabulary and none of the structure, and it has to keep reaching the user intact.
    """
    stripped = text.strip()
    if not stripped:
        return False
    if stripped[: len(P_ENVELOPE_PREFIX)].lower() == P_ENVELOPE_PREFIX:
        return True
    # A router stamp is only an envelope when it opens the message; quoted mid-prose it is speech.
    m = P_ROUTER_STAMP.search(stripped)
    return bool(m and m.start() <= 80 and stripped.lower().startswith(("request ", "[", "error")))


@typechecked
def classify_provider_error(text: str) -> Optional[ProviderError]:
    """Return what the provider actually said, or None when this is the agent talking."""
    if not looks_like_provider_envelope(text):
        return None

    stripped = text.strip()
    low = stripped.lower()

    status: Optional[int] = None
    lane: Optional[str] = None

    stamp = P_ROUTER_STAMP.search(stripped)
    if stamp:
        status = int(stamp.group(1))
        inner = stamp.group(0)
        lane_m = re.search(r"\[([a-z0-9._-]+)/", inner, re.I)
        lane = lane_m.group(1).lower() if lane_m else None
    else:
        m = P_STATUS.search(stripped)
        if m:
            status = int(m.group(1) or m.group(2))

    p_windows = [parse_duration(m.group(1)) for m in P_RESET.finditer(stripped)]
    p_windows = [w for w in p_windows if w]
    reset_seconds = max(p_windows) if p_windows else None

    # The policy filter's refusal arrives as a 400 with the verdict in words; it must win over the status so the recap ratchet owns it, never a generic retry.
    if is_content_policy_block(stripped):
        kind = POLICY
    # Status first: it is the provider's own verdict. Words only for shapes carrying no status at all.
    elif status in (401, 403):
        kind = AUTH
    elif status == 429:
        kind = QUOTA
    elif status is not None and 500 <= status <= 599:
        kind = OVERLOADED
    elif "unable to connect" in low or "connection" in low or "network" in low:
        kind = CONNECTION
    elif "quota" in low or "rate limit" in low:
        kind = QUOTA
    elif "overloaded" in low:
        kind = OVERLOADED
    else:
        kind = UNKNOWN

    return ProviderError(
        kind=kind, status=status, lane=lane, reset_seconds=reset_seconds, raw=stripped,
        subscription_spent=any(w in low for w in P_SUBSCRIPTION_SPENT),
    )


@typechecked
def p_humanize_window(seconds: int) -> str:
    if seconds < 90:
        return "under a minute"
    if seconds < 3600:
        return f"about {max(1, round(seconds / 60))} minutes"
    hours = seconds / 3600
    if hours < 48:
        return f"about {round(hours)} hours"
    return f"about {round(hours / 24)} days"


@typechecked
def user_facing_sentence(err: ProviderError, model: str) -> str:
    """One sentence the user can act on. Never the provider's words, never a status code.

    Deliberately says what happens NEXT rather than what went wrong: the goal is that a user never
    has to whip an answer out of the agent, so a message that only diagnoses is a half-fix.
    """
    who = "This model"
    if err.lane in ("antigravity", "gc", "ag"):
        who = "Gemini"
    elif err.lane in ("codex", "cx"):
        who = "ChatGPT"
    elif err.lane in ("claude", "cc", "anthropic"):
        who = "Claude"
    elif model:
        who = model

    if err.kind == QUOTA:
        if err.subscription_spent:
            # Only quote a window big enough to BE a quota reset. A couple of minutes is the
            # router's retry hint, and repeating it as the plan's reset time is just a wrong fact.
            p_when = (f" It resets in {p_humanize_window(err.reset_seconds)}."
                      if err.reset_seconds and err.reset_seconds > 6 * 3600 else "")
            return (f"{who} has used up its subscription allowance.{p_when} Switch this agent to "
                    "another model to keep going.")
        if err.reset_seconds and err.reset_seconds > 6 * 3600:
            return (
                f"{who} has hit its subscription limit and will not reset for "
                f"{p_humanize_window(err.reset_seconds)}. Switch this agent to another model to "
                "keep going."
            )
        if err.reset_seconds:
            return (
                f"{who} hit a short rate limit. Picking the work back up automatically in "
                f"{p_humanize_window(err.reset_seconds)}; you do not need to do anything."
            )
        return (
            f"{who} hit a rate limit. Retrying automatically; if it keeps happening, switch this "
            "agent to another model."
        )
    if err.kind == CONNECTION:
        return (
            "Lost the connection to the model. Resuming automatically as soon as it answers "
            "again; you do not need to resend anything."
        )
    if err.kind == OVERLOADED:
        return (
            f"{who} is temporarily overloaded on the provider's side. Retrying automatically."
        )
    if err.kind == AUTH:
        return (
            f"{who} needs reconnecting. Open Settings, Models, and click Reconnect on that row, "
            "then send your message again."
        )
    if err.kind == POLICY:
        return (
            "The model provider declined this request (its automated policy filter flagged the "
            "conversation's content). Rephrase your last message, or start a fresh chat about this "
            "topic."
        )
    # No retry is promised here because none is queued: an unknown error is not transient.
    return (
        "The model provider returned an error instead of an answer. Send your message again; if it "
        "keeps happening, switch this agent to another model."
    )


@typechecked
def is_transient(err: ProviderError) -> bool:
    """Whether waiting can plausibly fix it, which is what decides park-and-resume vs tell-the-user.

    A multi-hour quota reset is NOT transient: parking on it would leave the user staring at a
    silent agent for hours, which is the exact outcome this whole effort exists to prevent.
    """
    if err.kind in (CONNECTION, OVERLOADED):
        return True
    if err.kind == QUOTA:
        # An exhausted plan does not heal by waiting; parking on it is a silent stop in disguise.
        if err.subscription_spent:
            return False
        return err.reset_seconds is not None and err.reset_seconds <= 6 * 3600
    return False
