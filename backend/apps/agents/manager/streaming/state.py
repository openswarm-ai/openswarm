"""Mutable per-turn state for the agent streaming loop. Replaces the loop's `nonlocal`
locals with a captured object so the streaming/thinking closures can eventually move out of
agent_manager (a closure that mutates `state.field` needs no `nonlocal`)."""

import asyncio
from typing import Dict, List, Optional

from pydantic import BaseModel, ConfigDict, InstanceOf


class ThinkingState(BaseModel):
    """The consolidated-thinking side-channel for one turn: the live 'Thought for Ns ·
    N tokens · N tools' pill. A single persisted message id is reused across a multi-step
    turn so the bubble updates in place; everything resets at the next turn boundary."""

    model_config = ConfigDict(validate_assignment=True, arbitrary_types_allowed=True)

    # block index -> wall-clock start (s); popped to accumulate total_ms when a block ends.
    block_starts: Dict[int, float] = {}
    total_ms: int = 0
    # Stable id for the turn's single thinking message (frontend dedupe replaces in place).
    msg_id: Optional[str] = None
    text_parts: List[str] = []
    # Latest Gemini thoughtSignature, re-attached on later turns for reasoning continuity.
    thought_signature: Optional[str] = None
    # Background ticker handle; re-emits the pill every 1s so the elapsed counter keeps moving.
    ticker_task: Optional[InstanceOf[asyncio.Task]] = None


class TurnState(BaseModel):
    """Mutable per-turn streaming state: the live streaming-message ids, the accumulated
    assistant text, and the running token/char/timing counters. Reset at each turn boundary.
    (validate_assignment runs per SDK event, not per token, so the cost is negligible against
    a multi-second turn.)"""

    model_config = ConfigDict(validate_assignment=True)

    stream_text_msg_id: Optional[str] = None
    stream_tool_msg_ids_ordered: List[str] = []
    stream_block_index_map: Dict[int, str] = {}
    stream_text_accum: str = ""
    # The thinking block in flight, so a socket that connects mid-thought can be handed it (the text snapshot's twin).
    stream_thinking_msg_id: Optional[str] = None
    stream_thinking_accum: str = ""
    current_turn_emitted: bool = False
    number: int = 0
    first_event: bool = True
    tool_count: int = 0
    started_ts: Optional[float] = None
    total_ms: int = 0
    # ACTIVE time: sum of inter-event deltas with stall gaps capped, so a turn that waits an hour
    # on an approval or a wedged workflow books seconds of work, not the wall gap (ENG-189).
    last_event_ts: Optional[float] = None
    active_ms: int = 0
    output_tokens: int = 0
    assistant_text_chars: int = 0
    tool_input_chars: int = 0
    # Cumulative-token snapshot taken at turn start; subtracted at emit time so the thinking pill shows THIS turn's new tokens, not the whole session's running total.
    baseline_session_in: int = 0
    baseline_session_out: int = 0
    baseline_children_in: int = 0
    baseline_children_out: int = 0
    baseline_captured: bool = False
    # CLI compact_boundary events seen this turn; one plus a ProcessError = the autocompact-thrash death the context-pressure valve retries.
    compact_boundaries: int = 0
    # Provider 500s/429s the CLI retried on its own; the user sees only a long silence, so these are counted rather than lost.
    provider_retries: int = 0
    provider_retry_wait_ms: int = 0
    # Mid-turn context breaker: fires once per turn, and only after a below-trigger reading (a turn that STARTS over the trigger must run, or a failed shrink would break-loop forever).
    context_break_fired: bool = False
    saw_input_below_trigger: bool = False
    # Said once per turn when the provider sends no usage at all, so the breaker being
    # structurally inert on that lane is visible instead of silent (ENG-391).
    usage_absence_reported: bool = False
    saw_usable_usage: bool = False
    usage_seen_reported: bool = False
    first_input_reading: int = 0
    # The LAST inference step's request size (input + cache read + cache creation): the true live context. The ResultMessage's usage sums these across every step of the turn, which is billing, not context.
    last_step_input: int = 0
