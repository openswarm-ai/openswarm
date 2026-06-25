"""The consolidated-thinking pill: build the running 'Thought for Ns · N tokens · N tools'
aggregate message and broadcast it, plus the 1s ticker that keeps the elapsed counter moving.
Lifted out of the agent loop; operates on the passed TurnState/ThinkingState + session."""

import asyncio
import time
from typing import Dict, Optional
from uuid import uuid4

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState

import logging
logger = logging.getLogger(__name__)


@typechecked
async def emit_consolidated_thinking(thinking: ThinkingState, turn: TurnState, session: AgentSession, session_id: str, sessions: Dict[str, AgentSession], force_provider_unavailable: bool = False) -> None:
    """Build the running aggregate Message and broadcast it.
    Safe to call multiple times, uses a stable per-turn id
    so the frontend dedupes by id and updates the bubble in
    place.

    Emission rule: emit when ANY of the following is true:
      1. Reasoning text exists (Anthropic happy path).
      2. Upstream provider reported reasoning tokens via
         9Router (best-effort path for GPT/Gemini).
      3. force_provider_unavailable=True, caller has
         determined this turn went through a translator that
         doesn't carry reasoning content (cx/ or gc/), and
         the user should see a "provider doesn't expose
         reasoning text" pill regardless of metric
         availability. This is what makes GPT/Gemini turns
         show a pill even when 9Router can't surface a
         token count.
    """
    upstream_reasoning_tokens: Optional[int] = None
    # Probe 9Router for the upstream reasoning-token count whenever (a) there's no in-process text, OR (b) the caller flagged this as a force-emit for a route that strips reasoning. Case (b) is what makes the FINAL emit on GPT/Gemini show the real reasoning count (e.g. 196) instead of the heuristic chars/3.6 of the answer text (e.g. 13).
    if not thinking.text_parts or force_provider_unavailable:
        try:
            from backend.apps.nine_router import (
                get_latest_reasoning_tokens,
                is_running as nine_router_running,
            )
            if nine_router_running():
                rt = await get_latest_reasoning_tokens(model_hint=session.model)
                if rt and rt > 0:
                    upstream_reasoning_tokens = rt
        except Exception:
            pass
        if (
            not thinking.text_parts
            and upstream_reasoning_tokens is None
            and not force_provider_unavailable
        ):
            # No text, no upstream signal, and caller didn't ask for the unavailable-pill, nothing to show.
            return
    joined_text = "\n".join(thinking.text_parts)
    # Total turn output token estimate. Combines two sources: - SDK usage.output_tokens summed across completed AssistantMessages (authoritative for finished blocks). - chars/3.6 heuristic over the running streams of thinking + assistant-text + tool-input JSON (covers in-flight blocks the SDK hasn't billed yet, i.e. the answer the user is currently reading). Take the max so the number doesn't visually shrink as the SDK's authoritative count overtakes our running heuristic.
    running_chars = (
        len(joined_text)
        + turn.assistant_text_chars
        + turn.tool_input_chars
    )
    heuristic_tokens = max(1, round(running_chars / 3.6)) if running_chars else 0
    turn_tokens: Optional[int] = None
    # Priority order: 1. Upstream reasoning-token count from 9Router (the only honest signal for GPT/Gemini, captured above). 2. SDK-reported usage.output_tokens (Anthropic). 3. chars/3.6 heuristic over running streams (live UI).
    if upstream_reasoning_tokens and upstream_reasoning_tokens > 0:
        turn_tokens = upstream_reasoning_tokens
    elif turn.output_tokens > 0 or heuristic_tokens > 0:
        turn_tokens = max(turn.output_tokens, heuristic_tokens)
    else:
        try:
            from backend.apps.nine_router import (
                get_latest_reasoning_tokens,
                is_running as nine_router_running,
            )
            if nine_router_running():
                rt = await get_latest_reasoning_tokens(model_hint=session.model)
                if rt and rt > 0:
                    turn_tokens = rt
        except Exception:
            pass
    if turn.started_ts is not None:
        turn.total_ms = int((time.time() - turn.started_ts) * 1000)
        # Accumulate into session-level "agent active time" and the per-model breakdown so a session that spans multiple turns reports the total wall-clock time the agent was running. Per-model bucket uses the model active *now* (model can be switched mid-turn but the current value is the right attribution for the work just produced).
        try:
            session.agent_active_ms = int(getattr(session, "agent_active_ms", 0) or 0) + turn.total_ms
            m = session.model or "unknown"
            session.time_per_model[m] = int(session.time_per_model.get(m, 0)) + turn.total_ms
        except Exception:
            pass
    if thinking.msg_id is None:
        thinking.msg_id = uuid4().hex
    # Combined token total for the pill, input + output for the parent turn PLUS any work delegated to subagents (browser agents, invoke-agent forks) and tool MCP servers that produced their own usage on this turn. The user-visible answer to "how big is this turn" is the all-in sum, not just the primary's output. We sum every reachable source: - parent's input  (session.tokens["input"], ResultMessage.usage at line ~2886) - parent's output (session.tokens["output"], same ResultMessage) - every direct sub-session whose parent_session_id points at this session (browser agents, sub-agent forks, invoke-agent calls book their own usage at subprocess return time, agent_manager.py:1365 + browser_agent.py:1000-1001) This mirrors how billing accumulates per-turn, caches, tool MCP servers that talk to LLMs (e.g. summarizers), and subagent reasoning all show up under the parent's "session.tokens" once their result lands. Read cumulative session totals + cumulative subagent totals at this moment, then subtract the turn-start baseline to get THIS TURN'S delta. Without subtracting, the second turn's pill would show turn-1 work added to turn-2 work, the third would show all three, etc. Pill uses the FRESH lane (uncached input only). session.tokens ["input"] stays full for the context-fullness bar + cost; the bubble shows the NEW tokens this turn, not the cached re-reads.
    cum_in = 0
    cum_out = 0
    if isinstance(session.tokens, dict):
        cum_in = int(session.tokens.get("input_fresh", 0) or 0)
        cum_out = int(session.tokens.get("output", 0) or 0)
    cum_children_in = 0
    cum_children_out = 0
    try:
        for child in sessions.values():
            if getattr(child, "parent_session_id", None) != session.id:
                continue
            ct = getattr(child, "tokens", None)
            if not isinstance(ct, dict):
                continue
            cum_children_in += int(ct.get("input_fresh", 0) or 0)
            cum_children_out += int(ct.get("output", 0) or 0)
    except Exception:
        pass

    # Fall back to cumulative if the baseline wasn't captured (degenerate empty turn, better than showing zero).
    if turn.baseline_captured:
        parent_in = max(0, cum_in - turn.baseline_session_in)
        parent_out = max(0, cum_out - turn.baseline_session_out)
        children_in = max(0, cum_children_in - turn.baseline_children_in)
        children_out = max(0, cum_children_out - turn.baseline_children_out)
    else:
        parent_in = cum_in
        parent_out = cum_out
        children_in = cum_children_in
        children_out = cum_children_out

    # Fresh input + output = the NEW tokens this turn. The old framework-overhead subtraction is gone on purpose: it was an estimate to strip the cached static prefix out of the full input number, and the fresh lane already excludes that prefix exactly, so subtracting it again would double-discount to ~0.
    turn_total_tokens: Optional[int] = (
        parent_in + parent_out + children_in + children_out
    )
    if not turn_total_tokens or turn_total_tokens <= 0:
        turn_total_tokens = None
    consolidated = Message(
        id=thinking.msg_id,
        role="thinking",
        content=joined_text,
        branch_id=session.active_branch_id,
        elapsed_ms=turn.total_ms or None,
        tokens=turn_tokens,
        input_tokens=turn_total_tokens,
        tool_count=turn.tool_count or None,
    )
    existing_idx = next(
        (i for i, m in enumerate(session.messages)
         if m.id == thinking.msg_id),
        -1,
    )
    if existing_idx >= 0:
        session.messages[existing_idx] = consolidated
    else:
        session.messages.append(consolidated)
    try:
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": consolidated.model_dump(mode="json"),
        })
    except Exception:
        logger.exception("Failed to emit consolidated thinking message")


@typechecked
async def ticker_loop(thinking: ThinkingState, turn: TurnState, session: AgentSession, session_id: str, sessions: Dict[str, AgentSession]) -> None:
    """Re-emit the consolidated thinking message every 1s so
    the elapsed-time counter keeps ticking through gaps
    where no SDK events fire (e.g. while a tool is running
    or while assistant text is being generated). Cancelled
    at turn boundaries from `ResultMessage`."""
    try:
        while True:
            await asyncio.sleep(1.0)
            await emit_consolidated_thinking(thinking, turn, session, session_id, sessions)
    except asyncio.CancelledError:
        pass

