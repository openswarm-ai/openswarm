"""Detect a turn that ended without an answer: the model ran tools and then quit with a
thinking-only/empty end_turn, so the chat's last visible event is a tool result and the user
gets a Done pill with no response. Live incident (2026-08-03, opus-5-cc lint audit): the final
inference was a 2-char thinking block + end_turn at 70K/1M context, scored as a clean success.
The loop nudges such a turn ONCE with a hidden continuation; twice in a row surfaces honestly."""

import logging
from typing import List

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.session.history_compaction import get_branch_messages

NUDGE_PROMPT = (
    "You ended your turn without reporting anything. Continue exactly where you left off and "
    "finish the task; when done, always end with your findings or answer as normal text."
)

logger = logging.getLogger(__name__)


NUDGE_HARD_CAP = 3


@typechecked
def maybe_nudge_empty_finish(session: AgentSession, session_id: str) -> bool:
    """Arm a hidden continue nudge when the finished turn quit silently; the loop's existing
    auto-continuation block dispatches it. A re-nudge must be EARNED by new tool work since the
    last one (the model is visibly still working, just mute); a stalled continuation surfaces
    honestly, so this can never ping-pong a model that has nothing left to do."""
    if getattr(session, "pending_continuation", False) or session.empty_finish_nudges >= NUDGE_HARD_CAP:
        return False
    if not turn_finished_empty(session):
        return False
    p_tool_calls = p_count_tool_calls(session)
    if session.empty_finish_nudges >= 1 and p_tool_calls <= session.empty_finish_progress_mark:
        return False
    session.empty_finish_progress_mark = p_tool_calls
    session.empty_finish_nudges += 1
    session.pending_continuation = True
    session.pending_continuation_prompt = NUDGE_PROMPT
    logger.warning(f"Agent {session_id}: turn finished with no answer after tool work; one hidden continue nudge")
    try:
        from backend.apps.service.client import submit_diagnostic
        from backend.apps.agents.core import flight_recorder as p_fr
        # A silent quit is the hardest class to diagnose after the fact, so it gets the same envelope
        # as a hard error: without breadcrumbs you cannot see what the turn was doing when it gave up.
        submit_diagnostic({
            "kind": "empty_finish_nudge",
            "session_id": session_id,
            "model": session.model,
            "tool_calls": p_tool_calls,
            "nudge": session.empty_finish_nudges,
            "flight": p_fr.build_envelope(
                session_id, "empty_finish_nudge", "silent_quit", session.model, "stream", session.empty_finish_nudges,
            ),
        })
    except Exception:
        pass
    return True

# A turn legitimately ENDS on these tools: the rendered widget or delegation IS the answer.
P_ANSWER_TOOL_MARKERS = ("openswarm-ui", "ShowUI", "AskUI", "AskUserQuestion")


@typechecked
def p_count_tool_calls(session: AgentSession) -> int:
    return sum(1 for m in get_branch_messages(session) if getattr(m, "role", "") == "tool_call")


def p_tool_name_of(msg: object) -> str:
    content = getattr(msg, "content", None)
    if isinstance(content, dict):
        return str(content.get("tool") or content.get("tool_name") or "")
    return ""


@typechecked
def turn_finished_empty(session: AgentSession) -> bool:
    """True when the branch's last visible message is a tool result whose call was ordinary work
    (not a UI/answer tool): the model did things and then said nothing."""
    msgs: List = get_branch_messages(session)
    p_last_call_name = ""
    for m in reversed(msgs):
        if getattr(m, "hidden", False):
            continue
        role = getattr(m, "role", "")
        if role == "assistant":
            text = m.content if isinstance(m.content, str) else ""
            return not text.strip()
        if role == "tool_result":
            continue
        if role == "tool_call":
            p_last_call_name = p_tool_name_of(m)
            return not any(marker in p_last_call_name for marker in P_ANSWER_TOOL_MARKERS)
        if role in ("user", "system"):
            return False
    return False
