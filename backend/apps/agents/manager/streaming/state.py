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
    current_turn_emitted: bool = False
    number: int = 0
    first_event: bool = True
    tool_count: int = 0
    started_ts: Optional[float] = None
    total_ms: int = 0
    output_tokens: int = 0
    assistant_text_chars: int = 0
    tool_input_chars: int = 0
    # Cumulative-token snapshot taken at turn start; subtracted at emit time so the thinking pill shows THIS turn's new tokens, not the whole session's running total.
    baseline_session_in: int = 0
    baseline_session_out: int = 0
    baseline_children_in: int = 0
    baseline_children_out: int = 0
    baseline_captured: bool = False
