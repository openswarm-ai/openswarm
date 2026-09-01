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
from backend.apps.agents.manager.run.empty_finish_telemetry import report_exhausted, report_nudge

NUDGE_PROMPT = "Finish the task, then answer in plain text."

# The last allowed nudge stops asking for more work: field data (Haik, 2026-08-08, 20 nudges in 5
# sessions) showed the model reads "continue and finish" as MORE tool calls then another silent
# quit, so the escalation demands the one thing the user is actually missing: text.
FINAL_NUDGE_PROMPT = "No more tools. Report what is done, what is left, and what blocks you."

# Post-cap honesty: the machinery is out of nudges and the turn STILL ended silent, so say so in
# the transcript instead of leaving a Done pill over a wall of tool rows.
EXHAUSTED_NOTE = (
    "The agent stopped before reporting back. Its work so far is above; send a message to carry on "
    "from there."
)

# Same situation, no work to point at. The old single string told a user with an empty transcript to
# "check the tool results above" when there were none, and to "ask it to summarize" when there was
# nothing to summarize: two instructions that cannot be followed, on the turn they are most alarmed.
EXHAUSTED_NOTE_NO_PROGRESS = (
    "The agent could not get started on this one. Send your message again, or switch this agent to "
    "another model."
)

# Same "no work this turn", but in a chat that has ALREADY done a lot of it. Telling that user the
# agent "could not get started" is plainly false to anyone reading their own transcript, and telling
# them to switch models sends them after the wrong thing: a new model inherits the same long
# conversation and stalls the same way. Seen live 2026-09-01 (Ken, 1.7.9): one chat, 322 tool calls,
# input 111K-164K, six stalls in an hour, and this was the note it ended on.
EXHAUSTED_NOTE_LONG_CHAT = (
    "The agent stopped without replying, and this conversation has gotten long enough that it is "
    "the likely cause. Send your message again to retry, or start a fresh chat for the next part; "
    "switching models will not help, since a new one carries the same conversation."
)

logger = logging.getLogger(__name__)


NUDGE_HARD_CAP = 3

# Below this a quit is not about depth, so bounding the last rung would cost a rebuild and buy
# nothing. Measured on the field install whose quits were read one by one: every one landed between
# 68K and 166K input, and the nudge-1/2/3 medians climb 105K -> 125K -> 135K, i.e. the ladder gets
# DEEPER at each rung and fails harder for the same reason (ENG-399).
FINAL_RUNG_BOUND_TOKENS = 60_000


@typechecked
def final_rung_bound() -> int:
    """The depth above which the last rung gets bounded, with a drill override.

    Otherwise this path costs a genuine 60K-token conversation to reach even once, which is exactly
    how the 50KB cap and the mid-turn breaker both shipped never having fired. Unset everywhere
    except a drill; junk is ignored rather than silently trusted (same contract as
    OSW_COMPACT_CEILING_TOKENS)."""
    import os as p_os
    raw = p_os.environ.get("OSW_FINAL_RUNG_BOUND_TOKENS", "").strip()
    if raw:
        try:
            override = int(raw)
            if override > 0:
                return override
        except ValueError:
            logger.warning(f"ignoring junk OSW_FINAL_RUNG_BOUND_TOKENS={raw!r}")
    return FINAL_RUNG_BOUND_TOKENS


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
            surface_exhausted(session, session_id)
        return False
    if session.empty_finish_nudges >= NUDGE_HARD_CAP:
        surface_exhausted(session, session_id)
        return False
    p_tool_calls = count_tool_calls(session)
    if session.empty_finish_nudges >= 1 and p_tool_calls <= session.empty_finish_progress_mark:
        # The nudge bought no new work, so re-nudging would ping-pong a model with nothing left.
        # Refusing is right; ending the ask in SILENCE is not, and that is what the user actually
        # reports as "the agent just stopped" (Haik's poke storms).
        surface_exhausted(session, session_id)
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
    # Only rebuild when the rebuild would actually BUY something. Every rebuild re-sends an authored recap, and on the subscription lane that is a refusable request; rebuilding on every repeat quit above the 40% floor is what took fleet policy blocks from 1 install to 7 the day exp.16 shipped this. A quit right after a rebuild has nothing left to reclaim so it stops paying, while a quit after history genuinely regrew still compacts, which is the ENG-354 stuck-forever case. Reclaim, not a token watermark: session.tokens["input"] still reads the pre-compaction value until a turn reports, so anything keyed on it re-fires anyway.
    from backend.apps.agents.manager.session.proactive_prune import MIN_RECLAIM_TOKENS, estimate_aged_rebuild_tokens
    # Measured against the REPORTED input, not our local history: a rebuild's win is discarding the CLI's own untrimmed transcript (which is what input counts) and replacing it with our compact recap. Comparing our history to itself said "nothing to reclaim" for exactly the ENG-354 sessions whose bloat lives in the CLI.
    p_reclaim = p_input - estimate_aged_rebuild_tokens(session)
    # Drill seam: the ENG-354 negative control runs the exp.14 behavior (no compact) on identical bits.
    p_disabled = p_os.environ.get("OSW_DISABLE_EMPTY_FINISH_COMPACT") == "1"
    if not p_disabled and p_input >= p_floor and p_reclaim >= MIN_RECLAIM_TOKENS and maybe_compact(session, force=True):
        session.needs_fresh_session = True
        logger.warning(f"Agent {session_id}: empty finish at {p_input} input tokens (repeat={p_repeat}); compacted history before the nudge, reclaiming ~{p_reclaim}")
    session.empty_finish_nudges += 1
    session.pending_continuation = True
    p_final = session.empty_finish_nudges >= NUDGE_HARD_CAP
    # A ladder whose rungs all fail for the same reason is not a ladder. Rungs 1 and 2 just died in
    # THIS context, and the compaction above is gated on reclaiming 20K, so on a big irreducible
    # history the last rung walked into the same wall with tools taken away. It is the user's last
    # chance, so it is bounded BY CONSTRUCTION instead: a fresh request carrying the model's own
    # distilled summary and no trail at all, which cannot be too big however the history grew.
    if p_final and p_input >= final_rung_bound():
        maybe_compact(session, force=True)
        session.history_prefix_once = "summary"
        session.needs_fresh_session = True
        logger.warning(
            f"Agent {session_id}: final nudge at {p_input} input tokens; bounding it to a "
            f"summary-only request so the last rung cannot die of the same depth as the first two"
        )
    session.pending_continuation_prompt = FINAL_NUDGE_PROMPT if p_final else NUDGE_PROMPT
    # Wording alone did not hold: the same escalation shipped in 1.7.6 and the prods came back on
    # 1.7.7, so the last turn now runs with no tools at all rather than being asked nicely.
    session.pending_continuation_toolless = p_final
    logger.warning(f"Agent {session_id}: turn finished with no answer after tool work; one hidden continue nudge")
    report_nudge(session, session_id, p_input, p_tool_calls)

    return True

@typechecked
def p_recovery_retry_pending(session: AgentSession) -> bool:
    """True when the queued continuation is a retry for a PROVIDER failure, not a nudge of ours."""
    if not getattr(session, "pending_continuation", False):
        return False
    from backend.apps.agents.manager.streaming.auth_retry import (
        AUTH_RETRY_PROMPT,
        TRANSIENT_RETRY_PROMPT,
    )
    from backend.apps.agents.manager.run.reconnect_resume import RECONNECT_PROMPT
    return getattr(session, "pending_continuation_prompt", "") in (
        AUTH_RETRY_PROMPT, TRANSIENT_RETRY_PROMPT, RECONNECT_PROMPT,
    )


@typechecked
def session_showed_work(session: AgentSession) -> bool:
    """Whether this CHAT has real work behind it, regardless of what this one turn managed.

    `turn_showed_work` answers "is there anything to point at since the user last spoke", which is
    the right question for the note's wording but the wrong one for its ADVICE: a chat with hundreds
    of tool calls that stalls is a depth problem, not a model problem."""
    from backend.apps.agents.manager.session.history_compaction import get_branch_messages
    return any(getattr(m, "role", "") in ("tool_call", "tool_result")
               for m in get_branch_messages(session))


@typechecked
def turn_showed_work(session: AgentSession) -> bool:
    """Whether anything the note could point at actually exists since the user last spoke."""
    from backend.apps.agents.manager.session.history_compaction import get_branch_messages
    msgs = [m for m in get_branch_messages(session) if not getattr(m, "hidden", False)]
    p_last_user = -1
    for i, m in enumerate(msgs):
        if getattr(m, "role", "") == "user":
            p_last_user = i
    return any(getattr(m, "role", "") in ("tool_call", "tool_result")
               for m in msgs[p_last_user + 1:])


@typechecked
def surface_exhausted(session: AgentSession, session_id: str) -> None:
    """All nudges spent and the turn still ended mute: put one honest system line in the
    transcript, once per exhaustion (the flag resets with the counters on a real user message)."""
    if getattr(session, "empty_finish_surfaced", False):
        return
    # A RECOVERY retry means the turn is still going, so saying it stopped is a lie told at the
    # worst possible moment. The nudge ladder also rides pending_continuation, and its whole purpose
    # is to end in this very message, so the flag alone is the wrong test: key on whose continuation
    # it is. Leave empty_finish_surfaced unset either way, so the honest line still fires if the
    # recovery itself ends mute.
    if getattr(session, "awaiting_reconnect", False) or p_recovery_retry_pending(session):
        return
    session.empty_finish_surfaced = True
    report_exhausted(session, session_id)
    try:
        import asyncio
        from backend.apps.agents.core.models import Message
        from backend.apps.agents.core.ws_manager import ws_manager
        if turn_showed_work(session):
            p_note = EXHAUSTED_NOTE
        elif session_showed_work(session):
            p_note = EXHAUSTED_NOTE_LONG_CHAT
        else:
            p_note = EXHAUSTED_NOTE_NO_PROGRESS
        p_msg = Message(role="system", content=p_note, branch_id=session.active_branch_id)
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
def count_tool_calls(session: AgentSession) -> int:
    return sum(1 for m in get_branch_messages(session) if getattr(m, "role", "") == "tool_call")


def p_tool_name_of(msg: object) -> str:
    content = getattr(msg, "content", None)
    if isinstance(content, dict):
        return str(content.get("tool") or content.get("tool_name") or "")
    return ""


@typechecked
def p_text_of(content: object) -> str:
    """The visible text of an assistant message whatever shape its writer used (a plain string, a
    content-block list, a dict block); a structured final answer used to score as a silent quit."""
    if isinstance(content, str):
        return content
    if isinstance(content, dict):
        return str(content.get("text") or "")
    if isinstance(content, list):
        return "".join(p_text_of(c) for c in content)
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
            return not p_text_of(m.content).strip()
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
