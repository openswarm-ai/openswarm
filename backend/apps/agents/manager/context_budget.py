"""Token accounting + the context-ratio compaction trigger, lifted out of the agent loop.
Both operate on a passed AgentSession (no manager state). emit_context_update writes the
live token counts onto the session and broadcasts them to the UI; maybe_compact decides,
from the same input_tokens/context_window ratio, whether to mark history for trimming.

Compaction here only MARKS (sets compacted_through_msg_id); it never mutates
session.messages, the originals stay for the UI drawer and only the history sent to the SDK
is trimmed downstream (see backend/CLAUDE.md: "compaction must actually trim, not just mark")."""

from typing import Dict, Optional

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.history_compaction import get_branch_messages
from backend.apps.agents.manager.streaming.state import TurnState


@typechecked
def compact_trigger_tokens(session: AgentSession) -> int:
    """The token count where compaction fires: the TIGHTER of the pct threshold and the
    absolute ceiling (on a 200K window the pct wins at 130K; on a 1M window the ceiling
    wins at 180K, not 650K)."""
    window = max(1, session.context_window)
    abs_pct = min(1.0, session.compact_abs_ceiling_tokens / window)
    return int(window * min(session.compact_threshold_pct, abs_pct))


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
        return False
    # Keep the session's counter honest mid-turn: a broken turn never gets its ResultMessage accounting, and the next pre-send guard reads this.
    session.tokens["input"] = total
    turn.last_step_input = total
    if total < compact_trigger_tokens(session):
        turn.saw_input_below_trigger = True
        return False
    if turn.context_break_fired or not turn.saw_input_below_trigger:
        return False
    turn.context_break_fired = True
    maybe_compact(session, force=True)
    session.needs_fresh_session = True
    session.pending_continuation = True
    session.pending_continuation_prompt = CONTINUATION_PROMPT
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
