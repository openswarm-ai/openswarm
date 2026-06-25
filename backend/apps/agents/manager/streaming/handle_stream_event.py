"""Handle one streaming StreamEvent from the SDK: the incremental content_block_start /
delta / stop / message_stop path that drives live text, thinking, and tool streaming to the UI.
Lifted out of the agent loop; mutates the passed TurnState / ThinkingState by reference and
writes the manager's live-partial mirror, exactly as it did inline."""

import time
from datetime import datetime
from typing import Dict
from uuid import uuid4

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState
from backend.apps.agents.manager.streaming.PartialReply import PartialReply

try:
    from claude_agent_sdk.types import StreamEvent
except ImportError:  # the SDK is optional at runtime (mock mode); keep this module importable
    StreamEvent = object  # type: ignore


@typechecked
async def handle_stream_event(
    message: StreamEvent,
    session: AgentSession,
    session_id: str,
    turn: TurnState,
    thinking: ThinkingState,
    live_partial: Dict[str, PartialReply],
) -> None:
    event = message.event
    event_type = event.get("type")

    if event_type == "content_block_start":
        # Stamp the first stream event of the session so the session list can show "first response at HH:MM" on reload. Only the first turn sets this; later turns leave it untouched.
        if session.first_response_at is None:
            session.first_response_at = datetime.now()

        block = event.get("content_block", {})
        index = event.get("index")
        block_type = block.get("type")

        if block_type == "text":
            if turn.stream_text_msg_id is None:
                turn.stream_text_msg_id = uuid4().hex
                await ws_manager.send_to_session(session_id, "agent:stream_start", {
                    "session_id": session_id,
                    "message_id": turn.stream_text_msg_id,
                    "role": "assistant",
                })
            turn.stream_block_index_map[index] = turn.stream_text_msg_id

        elif block_type == "thinking":
            # Reasoning trace from thinking-capable models (GPT-5.3 Codex, Gemini 3 Pro/Flash, Claude with extended thinking). Rendered as a collapsible "thinking" message in the UI via the existing stream infrastructure, the frontend already handles role="thinking" for the DynamicIsland/agent card rendering.
            thinking_msg_id = uuid4().hex
            turn.stream_block_index_map[index] = thinking_msg_id
            # Server-stamp start so we can accumulate per-turn elapsed_ms across multiple thinking blocks (think → tool → think → answer turns sum correctly).
            thinking.block_starts[index] = time.time()
            await ws_manager.send_to_session(session_id, "agent:stream_start", {
                "session_id": session_id,
                "message_id": thinking_msg_id,
                "role": "thinking",
            })

        elif block_type == "tool_use":
            tool_msg_id = uuid4().hex
            turn.stream_tool_msg_ids_ordered.append(tool_msg_id)
            turn.stream_block_index_map[index] = tool_msg_id
            # Stream-level tool count for the thinking pill. OpenAI/Gemini-through-9Router AssistantMessage envelopes are sometimes incomplete, so this stream count guarantees "N tools used" renders cross-provider; the AssistantMessage path dedupes against it.
            turn.tool_count += 1
            await ws_manager.send_to_session(session_id, "agent:stream_start", {
                "session_id": session_id,
                "message_id": tool_msg_id,
                "role": "tool_call",
                "tool_name": block.get("name", ""),
            })

    elif event_type == "content_block_delta":
        index = event.get("index")
        delta = event.get("delta", {})
        delta_type = delta.get("type")
        msg_id = turn.stream_block_index_map.get(index)

        if msg_id and delta_type == "text_delta":
            text_chunk = delta.get("text", "")
            turn.assistant_text_chars += len(text_chunk)
            turn.stream_text_accum += text_chunk
            live_partial[session_id] = PartialReply(
                msg_id=turn.stream_text_msg_id,
                text=turn.stream_text_accum,
                branch_id=session.active_branch_id,
            )
            await ws_manager.send_to_session(session_id, "agent:stream_delta", {
                "session_id": session_id,
                "message_id": msg_id,
                "delta": text_chunk,
            })
        elif msg_id and delta_type == "thinking_delta":
            # Thinking content streams as thinking_delta with a "thinking" field (not "text")
            think_chunk = delta.get("thinking", "")
            await ws_manager.send_to_session(session_id, "agent:stream_delta", {
                "session_id": session_id,
                "message_id": msg_id,
                "delta": think_chunk,
            })
        elif msg_id and delta_type == "input_json_delta":
            json_chunk = delta.get("partial_json", "")
            turn.tool_input_chars += len(json_chunk)
            await ws_manager.send_to_session(session_id, "agent:stream_delta", {
                "session_id": session_id,
                "message_id": msg_id,
                "delta": json_chunk,
            })

    elif event_type == "content_block_stop":
        index = event.get("index")
        msg_id = turn.stream_block_index_map.get(index)
        # If this was a thinking block, accumulate elapsed_ms server-side. We don't include per-block elapsed/tokens on the WS event, the pill stays in "Thinking…" until the AssistantMessage lands carrying the per-turn aggregate values.
        if index in thinking.block_starts:
            thinking.total_ms += int(
                (time.time() - thinking.block_starts.pop(index)) * 1000
            )
        if msg_id and msg_id != turn.stream_text_msg_id:
            await ws_manager.send_to_session(session_id, "agent:stream_end", {
                "session_id": session_id,
                "message_id": msg_id,
            })

    elif event_type == "message_stop":
        if turn.stream_text_msg_id:
            await ws_manager.send_to_session(session_id, "agent:stream_end", {
                "session_id": session_id,
                "message_id": turn.stream_text_msg_id,
            })
