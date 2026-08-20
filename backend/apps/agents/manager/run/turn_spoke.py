"""One invariant at the single exit: a finished turn always left the user something to read.

Every silent-stop fix so far has been a DETECTOR: empty finish, vanishing quit, stalled nudge,
produced-nothing, exhausted budget. Each one enumerates a shape somebody already found in the
field, which means the next shape nobody has found yet still ships as silence. That is the wrong
tier, and the ENG-354 history is the proof: the class kept coming back wearing a different hat.

So this does not classify anything. It asks the only question the user asks, at the one place every
terminal path passes through:

    since you last spoke to me, has anything appeared that I can read?

If not, the honest line goes in. It does not matter whether the cause was a silent quit, a shape
nobody has named, or a bug written next year: the state "turn ended, nothing to read" stops being
representable, rather than being caught case by case.

Deliberately last: the detectors upstream produce BETTER messages because they know why. This only
fires when every one of them declined, so it is a floor, never a replacement.
"""

import logging
from typing import List

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.empty_finish import EXHAUSTED_NOTE, P_ANSWER_TOOL_MARKERS
from backend.apps.agents.manager.session.history_compaction import get_branch_messages

logger = logging.getLogger(__name__)

# States where the turn is genuinely over. "stopped" is excluded on purpose: the user pressed stop,
# so they know exactly why it ended and do not need to be told.
P_TERMINAL = ("completed", "error")


@typechecked
def p_tool_name_of(msg: object) -> str:
    content = getattr(msg, "content", None)
    if isinstance(content, dict):
        return str(content.get("tool") or content.get("tool_name") or "")
    return ""


@typechecked
def turn_left_the_user_with_nothing(session: AgentSession) -> bool:
    """True when nothing readable has appeared since the user's last visible message."""
    msgs: List = [m for m in get_branch_messages(session) if not getattr(m, "hidden", False)]
    if not msgs:
        return False

    p_last_user = -1
    for i, m in enumerate(msgs):
        if getattr(m, "role", "") == "user":
            p_last_user = i
    if p_last_user < 0:
        return False

    for m in msgs[p_last_user + 1:]:
        role = getattr(m, "role", "")
        if role == "system":
            return False
        if role == "assistant":
            text = m.content if isinstance(m.content, str) else ""
            if text.strip():
                return False
        if role == "tool_call" and any(mk in p_tool_name_of(m) for mk in P_ANSWER_TOOL_MARKERS):
            # A rendered widget IS the answer; the user is looking at it.
            return False
    return True


@typechecked
def ensure_turn_spoke(session: AgentSession, session_id: str) -> bool:
    """Append the honest line if the turn is over and said nothing. Returns whether it fired."""
    if session.status not in P_TERMINAL:
        return False
    # A parked or continuing turn is not over; speaking now would be the lie.
    if getattr(session, "pending_continuation", False) or getattr(session, "awaiting_reconnect", False):
        return False
    if not turn_left_the_user_with_nothing(session):
        return False

    session.messages.append(
        Message(role="system", content=EXHAUSTED_NOTE, branch_id=session.active_branch_id)
    )
    logger.warning(
        f"Agent {session_id}: turn ended with nothing readable and no detector claimed it; "
        "the floor spoke instead of leaving the user with a bare Done"
    )
    return True
