"""Token accounting + the context-ratio compaction trigger, lifted out of the agent loop.
Both operate on a passed AgentSession (no manager state). emit_context_update writes the
live token counts onto the session and broadcasts them to the UI; maybe_compact decides,
from the same input_tokens/context_window ratio, whether to mark history for trimming.

Compaction here only MARKS (sets compacted_through_msg_id); it never mutates
session.messages, the originals stay for the UI drawer and only the history sent to the SDK
is trimmed downstream (see backend/CLAUDE.md: "compaction must actually trim, not just mark")."""

import os
import logging
from typing import Dict, Optional

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.history_compaction import get_branch_messages
from backend.apps.agents.manager.streaming.state import TurnState

logger = logging.getLogger(__name__)


@typechecked
def effective_window(session: AgentSession) -> int:
    """The window every budget here reasons about, so a squeeze drill scales US and the CLI from
    the same number and the race between the two compactions stays the production one (ENG-418)."""
    from backend.apps.agents.core.fault_injection import squeezed_context_window
    return squeezed_context_window() or max(1, session.context_window)


@typechecked
def compact_ceiling_tokens(session: AgentSession) -> int:
    """The absolute ceiling, with a drill override.

    The mid-turn breaker is otherwise only reachable by paying for a genuine 180K-token turn,
    which in practice meant it was never drilled at all: three attempts to fire it cost real
    money and still failed. `OSW_COMPACT_CEILING_TOKENS` lowers the bar so the same code path
    can be exercised in seconds. Unset everywhere except a drill, and a junk value is ignored
    rather than silently trusted."""
    raw = os.environ.get("OSW_COMPACT_CEILING_TOKENS", "").strip()
    if raw:
        try:
            override = int(raw)
        except ValueError:
            return session.compact_abs_ceiling_tokens
        if override > 0:
            return override
    from backend.apps.agents.core.fault_injection import squeezed_context_window
    p_squeeze = squeezed_context_window()
    if p_squeeze:
        # Scaled, not replaced: the ceiling is 18% of a real 1M window, and a drill that kept 180K
        # against a 30K window would put the ceiling six times past the wall it is meant to beat.
        p_real = max(1, session.context_window)
        return max(1, int(session.compact_abs_ceiling_tokens * p_squeeze / p_real))
    return session.compact_abs_ceiling_tokens


@typechecked
def compact_trigger_tokens(session: AgentSession) -> int:
    """The token count where compaction fires: the TIGHTER of the pct threshold and the
    absolute ceiling (on a 200K window the pct wins at 130K; on a 1M window the ceiling
    wins at 180K, not 650K)."""
    window = effective_window(session)
    ceiling = compact_ceiling_tokens(session)
    abs_pct = min(1.0, ceiling / window)
    return int(window * min(session.compact_threshold_pct, abs_pct))


# How much a turn must ADD before breaking it is worth the rebuild it costs. Same reasoning as the
# 20K the pre-nudge compaction is gated on: below this, the break spends more than it reclaims.
MIN_TURN_GROWTH_TOKENS = 20_000

CONTINUATION_PROMPT = (
    "Continue the task exactly where you left off. Your earlier progress in this chat is "
    "summarized above; do not redo completed steps, pick up at the next unfinished one."
)


@typechecked
def maybe_break_midturn(session: AgentSession, turn: TurnState, msg_usage: Dict) -> bool:
    """Mid-turn context breaker: one giant turn (dozens of tool calls off a single ask) can
    blow past every turn-boundary wall, so when a request's input usage crosses the compact
    trigger MID-turn, end the turn at the next message boundary (the pending_continuation
    break the MCPActivate flow already uses), force-compact, and auto-continue fresh.
    Live incident: 925K/1M with zero CLI compact_boundary events, task abandoned mid-way."""
    try:
        total = (
            int(msg_usage.get("input_tokens") or 0)
            + int(msg_usage.get("cache_creation_input_tokens") or 0)
            + int(msg_usage.get("cache_read_input_tokens") or 0)
        )
    except Exception:
        return False
    if total <= 0:
        # No usage on THIS message, which on the Anthropic lane is ordinary: mid-stream assistant
        # messages carry output usage only, and a later one carries the real input count. Reporting
        # here claimed the whole turn was unprotected on turns that were fine, and a liveness signal
        # that cries wolf hides the case it exists for. The honest claim is only available at turn
        # end, so report_usage_liveness() makes it there (ENG-391, corrected ENG-418).
        return False
    # Keep the session's counter honest mid-turn: a broken turn never gets its ResultMessage accounting, and the next pre-send guard reads this.
    turn.saw_usable_usage = True
    session.tokens["input"] = total
    turn.last_step_input = total
    p_trigger = compact_trigger_tokens(session)
    # Once per turn, say the guard is watching and what it is watching for. "The valve did not fire"
    # has three indistinguishable causes from outside (no usage at all, never eligible because the
    # turn started over the trigger, or simply never crossed), and each is a different bug. One line
    # per turn separates them, and it is the liveness signal this class has been missing.
    if not turn.usage_seen_reported:
        turn.usage_seen_reported = True
        turn.first_input_reading = total
        logger.info(
            "[context-break] session %s: watching, first reading %d against trigger %d (window %d)",
            getattr(session, "id", "?"), total, p_trigger, effective_window(session),
        )
    if total < p_trigger:
        turn.saw_input_below_trigger = True
        return False
    if turn.context_break_fired:
        return False
    # A turn is breakable when it CROSSED the trigger, or when it has GROWN materially past where it
    # started. The second half is the one that was missing, and it is not an edge case: measured live
    # 2026-08-28, the first usage reading a turn ever delivers was 94,404 against a 45,000 trigger,
    # so `saw_input_below_trigger` was never set and the breaker sat out the entire turn. In
    # production that is every long chat and every resumed session near its ceiling -- exactly the
    # 925K/1M blowout with no compact boundary that this guard was written for (ENG-418).
    # This costs a REBUILD, and rebuild frequency is the subscription lane's real risk, so the
    # once-per-turn latch below is what keeps the trade honest: at most one break per turn.
    p_grew = total - turn.first_input_reading >= MIN_TURN_GROWTH_TOKENS
    if not (turn.saw_input_below_trigger or p_grew):
        return False
    # The anti-loop, and the reason growth is safe to act on: a rebuild that failed to shrink lands
    # back at or above the last break, and breaking it again would rebuild forever. It must RUN.
    if session.last_break_input_tokens and turn.first_input_reading >= session.last_break_input_tokens:
        logger.warning(
            "[context-break] session %s: the last break rebuilt to %d, no smaller than the %d it "
            "broke at, so this turn runs unbroken rather than looping",
            getattr(session, "id", "?"), turn.first_input_reading, session.last_break_input_tokens,
        )
        return False
    turn.context_break_fired = True
    session.midturn_breaks += 1
    session.last_break_input_tokens = total
    maybe_compact(session, force=True)
    session.needs_fresh_session = True
    session.pending_continuation = True
    session.pending_continuation_prompt = CONTINUATION_PROMPT
    return True


@typechecked
def report_usage_liveness(session: AgentSession, turn: TurnState) -> bool:
    """At turn end, say out loud if the breaker never had a number to work with.

    On the codex/GPT lane assistant messages NEVER carry usage (it arrives only on the
    ResultMessage), so the breaker is inert for that whole session and one giant turn can run to
    the context ceiling with nothing watching. A guard may not disable itself in silence, and this
    is the only point where "never" is a fact rather than a guess."""
    if turn.saw_usable_usage or turn.usage_absence_reported:
        return False
    turn.usage_absence_reported = True
    logger.warning(
        "[context-break] session %s on model %s sent no per-message usage for the WHOLE turn, so "
        "the mid-turn context breaker never ran; that turn was unprotected against a single-turn "
        "context blowout (ENG-391)",
        getattr(session, "id", "?"), getattr(session, "model", "?"),
    )
    return True


@typechecked
def maybe_compact(session: AgentSession, force: bool = False) -> bool:
    """Mark history for compaction when ctx_used_pct >= compact_threshold_pct (or force).
    Returns True if a NEW summary boundary was set. Summarizes everything up to (but not
    including) the last 6 messages so recent intent stays visible to the model. Never
    touches session.messages."""
    if not force and session.tokens.get("input", 0) < compact_trigger_tokens(session):
        return False
    msgs = get_branch_messages(session)
    if len(msgs) < 4:
        return False
    cutoff = max(0, len(msgs) - 6)
    if cutoff == 0:
        return False
    last_id = msgs[cutoff - 1].id
    if session.compacted_through_msg_id == last_id and not force:
        return False
    session.compacted_through_msg_id = last_id
    return True


@typechecked
async def emit_context_update(
    session_id: str,
    session: AgentSession,
    *,
    input_tokens: Optional[int] = None,
    output_tokens: Optional[int] = None,
    cache_read_tokens: int = 0,
    cache_read_pct: float = 0.0,
) -> None:
    """Persist the live token counts onto the session and broadcast the context-usage meter
    to the UI. When input/output aren't supplied, the session's current counts are reused."""
    if input_tokens is None:
        input_tokens = int(session.tokens.get("input", 0) or 0)
    if output_tokens is None:
        output_tokens = int(session.tokens.get("output", 0) or 0)
    session.tokens["input"] = input_tokens
    session.tokens["output"] = output_tokens
    ctx_window = max(1, getattr(session, "context_window", 0) or 200_000)
    await ws_manager.send_to_session(session_id, "agent:context_update", {
        "session_id": session_id,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": cache_read_tokens,
        "cache_read_pct": cache_read_pct,
        "ctx_used_pct": round(input_tokens / ctx_window, 4) if input_tokens else 0.0,
        "context_window": ctx_window,
        "framework_overhead_tokens": session.framework_overhead_tokens,
        "active_mcps": list(session.active_mcps),
    })
