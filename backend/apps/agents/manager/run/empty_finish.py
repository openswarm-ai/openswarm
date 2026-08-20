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

# The last allowed nudge stops asking for more work: field data (Haik, 2026-08-08, 20 nudges in 5
# sessions) showed the model reads "continue and finish" as MORE tool calls then another silent
# quit, so the escalation demands the one thing the user is actually missing: text.
FINAL_NUDGE_PROMPT = (
    "Stop. Do not call any more tools. In plain chat text, right now: report what you have done "
    "so far, what is left, and anything blocking you. Even a partial status is required."
)

# Post-cap honesty: the machinery is out of nudges and the turn STILL ended silent, so say so in
# the transcript instead of leaving a Done pill over a wall of tool rows.
EXHAUSTED_NOTE = (
    "The agent stopped working without a final report. Ask it to summarize, or check the tool "
    "results above for where it got to."
)

logger = logging.getLogger(__name__)


NUDGE_HARD_CAP = 3


@typechecked
def maybe_nudge_empty_finish(session: AgentSession, session_id: str) -> bool:
    """Arm a hidden continue nudge when the finished turn quit silently; the loop's existing
    auto-continuation block dispatches it. A re-nudge must be EARNED by new tool work since the
    last one (the model is visibly still working, just mute); a stalled continuation surfaces
    honestly, so this can never ping-pong a model that has nothing left to do."""
    if getattr(session, "pending_continuation", False):
        return False
    if not turn_finished_empty(session):
        # A turn that produced NOTHING at all (no text, no tool call) leaves the same Done pill
        # over an empty chat, and the tail-walk above can't see it: with nothing persisted the
        # tail is still the user's own message. Nudging it would re-send a prompt the model just
        # refused, so say so instead of ending mute.
        if p_turn_produced_nothing(session):
            p_surface_exhausted(session, session_id)
        return False
    if session.empty_finish_nudges >= NUDGE_HARD_CAP:
        p_surface_exhausted(session, session_id)
        return False
    p_tool_calls = p_count_tool_calls(session)
    if session.empty_finish_nudges >= 1 and p_tool_calls <= session.empty_finish_progress_mark:
        # The nudge bought no new work, so re-nudging would ping-pong a model with nothing left.
        # Refusing is right; ending the ask in SILENCE is not, and that is what the user actually
        # reports as "the agent just stopped" (Haik's poke storms).
        p_surface_exhausted(session, session_id)
        return False
    session.empty_finish_progress_mark = p_tool_calls
    # At high context the silent quit is usually the model choking on the prompt itself, so
    # re-sending the same bloat just burns a nudge; compact FIRST and retry distilled (ENG-354).
    # Field data (Haik, 2026-08-19): opus-5 quits from ~149K, BELOW the 180K trigger, and his storm
    # sessions logged 130+ quits each; a REPEAT quit therefore compacts from a much lower floor,
    # because one failed nudge is proof the prompt itself is what the model is choking on.
    import os as p_os
    from backend.apps.agents.manager.context_budget import compact_trigger_tokens, maybe_compact
    p_input = int(session.tokens.get("input", 0) or 0)
    p_repeat = getattr(session, "empty_finish_total", 0) >= 1
    session.empty_finish_total = getattr(session, "empty_finish_total", 0) + 1
    p_floor = int((0.4 if p_repeat else 0.8) * compact_trigger_tokens(session))
    # Drill seam: the ENG-354 negative control runs the exp.14 behavior (no compact) on identical bits.
    p_disabled = p_os.environ.get("OSW_DISABLE_EMPTY_FINISH_COMPACT") == "1"
    if not p_disabled and p_input >= p_floor and maybe_compact(session, force=True):
        session.needs_fresh_session = True
        logger.warning(f"Agent {session_id}: empty finish at {p_input} input tokens (repeat={p_repeat}); compacted history before the nudge")
    session.empty_finish_nudges += 1
    session.pending_continuation = True
    p_final = session.empty_finish_nudges >= NUDGE_HARD_CAP
    session.pending_continuation_prompt = FINAL_NUDGE_PROMPT if p_final else NUDGE_PROMPT
    # Wording alone did not hold: the same escalation shipped in 1.7.6 and the prods came back on
    # 1.7.7, so the last turn now runs with no tools at all rather than being asked nicely.
    session.pending_continuation_toolless = p_final
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
            "input_tokens": p_input,
            "compacted": bool(session.needs_fresh_session),
            "tool_calls": p_tool_calls,
            "nudge": session.empty_finish_nudges,
            "flight": p_fr.build_envelope(
                session_id, "empty_finish_nudge", "silent_quit", session.model, "stream", session.empty_finish_nudges,
            ),
        })
    except Exception:
        pass
    return True

@typechecked
def p_surface_exhausted(session: AgentSession, session_id: str) -> None:
    """All nudges spent and the turn still ended mute: put one honest system line in the
    transcript, once per exhaustion (the flag resets with the counters on a real user message)."""
    if getattr(session, "empty_finish_surfaced", False):
        return
    session.empty_finish_surfaced = True
    try:
        import asyncio
        from backend.apps.agents.core.models import Message
        from backend.apps.agents.core.ws_manager import ws_manager
        p_msg = Message(role="system", content=EXHAUSTED_NOTE, branch_id=session.active_branch_id)
        session.messages.append(p_msg)
        asyncio.get_running_loop().create_task(ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": p_msg.model_dump(mode="json"),
        }))
        logger.warning(f"Agent {session_id}: silent finish after {NUDGE_HARD_CAP} nudges; surfaced honestly")
    except Exception:
        logger.exception("failed to surface exhausted empty-finish")


# A turn legitimately ENDS on these tools: the rendered widget or delegation IS the answer.
P_ANSWER_TOOL_MARKERS = ("openswarm-ui", "ShowUI", "AskUI", "AskUserQuestion")


@typechecked
def p_turn_produced_nothing(session: AgentSession) -> bool:
    """True when the model returned an empty hand: no reply, no tool work, nothing the user can
    read. Thinking does not count, because a collapsed reasoning trace is not an answer, and a
    thinking-only end_turn is the exact shape of the quits users report."""
    msgs: List = [
        m for m in get_branch_messages(session)
        if not getattr(m, "hidden", False) and getattr(m, "role", "") != "thinking"
    ]
    if not msgs or getattr(msgs[-1], "role", "") != "user":
        return False
    return not any(getattr(m, "role", "") in ("assistant", "tool_call") for m in msgs)


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
            # A user-message tail normally means a bare prompt (never claimed). But when the model
            # QUIT so hard it persisted nothing at all, and this session has already silent-quit
            # before, that vanishing act IS the quit repeating (Haik's poke storms: "continue" ->
            # instant thinking-only end_turn -> nothing persisted -> detector shrugged).
            return role == "user" and getattr(session, "empty_finish_total", 0) >= 1
    return False


@typechecked
def apply_toolless_continuation(session: AgentSession, allowed: List[str], mcp_servers: dict) -> tuple:
    """Strip every tool for the final nudge's turn, so "do not call any more tools" is a fact.

    Lives here rather than in RunOptions because this module already decides WHEN a turn is the
    final nudge; splitting the decision from its consequence is how the wording-only version
    survived a release."""
    if not getattr(session, "pending_continuation_toolless", False):
        return allowed, mcp_servers
    return [], {}
