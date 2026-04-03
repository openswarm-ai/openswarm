from typing import Any, Dict, Optional
from typeguard import typechecked
from uuid import uuid4

from backend.core.events.events import (
    EventCallback, StreamStartEvent, StreamDeltaEvent, StreamEndEvent,
)

# NOTE: if we wanna, we could abstract this into helper functions for each event type
@typechecked
async def handle_stream_event(
    session_id: str,
    event: Dict[str, Any],
    stream_text_msg_id: Optional[str],
    stream_tool_ids: list[str],
    block_map: dict[int, str],
    emit: Optional[EventCallback] = None,
) -> str | None:
    """Process a single StreamEvent and return the (possibly updated) text msg id."""
    assert "type" in event, "Stream event missing 'type'"
    event_type: str = event["type"]

    if event_type == "content_block_start":
        assert "index" in event, "content_block_start missing 'index'"
        assert "content_block" in event, "content_block_start missing 'content_block'"
        block: Dict[str, Any] = event["content_block"]
        index: int = event["index"]
        assert "type" in block, "content_block missing 'type'"
        block_type: str = block["type"]
        if block_type == "text":
            if stream_text_msg_id is None:
                stream_text_msg_id = uuid4().hex
                if emit:
                    await emit(StreamStartEvent(
                        session_id=session_id, message_id=stream_text_msg_id, role="assistant",
                    ))
            block_map[index] = stream_text_msg_id
        elif block_type == "tool_use":
            assert "name" in block, "tool_use content_block missing 'name'"
            tool_name: str = block["name"]
            tool_msg_id: str = uuid4().hex
            stream_tool_ids.append(tool_msg_id)
            block_map[index] = tool_msg_id
            if emit:
                await emit(StreamStartEvent(
                    session_id=session_id, message_id=tool_msg_id,
                    role="tool_call", tool_name=tool_name,
                ))

    elif event_type == "content_block_delta":
        assert "index" in event, "content_block_delta missing 'index'"
        assert "delta" in event, "content_block_delta missing 'delta'"
        index: int = event["index"]
        delta: Dict[str, Any] = event["delta"]
        msg_id: Optional[str] = block_map.get(index)
        if msg_id:
            assert "type" in delta, "delta missing 'type'"
            delta_type: str = delta["type"]
            if delta_type == "text_delta":
                assert "text" in delta, "text_delta missing 'text'"
                text: str = delta["text"]
                if emit:
                    await emit(StreamDeltaEvent(
                        session_id=session_id, message_id=msg_id, delta=text,
                    ))
            elif delta_type == "input_json_delta":
                assert "partial_json" in delta, "input_json_delta missing 'partial_json'"
                partial_json: str = delta["partial_json"]
                if emit:
                    await emit(StreamDeltaEvent(
                        session_id=session_id, message_id=msg_id, delta=partial_json,
                    ))

    elif event_type == "content_block_stop":
        assert "index" in event, "content_block_stop missing 'index'"
        msg_id: Optional[str] = block_map.get(event["index"])
        if msg_id and msg_id != stream_text_msg_id:
            if emit:
                await emit(StreamEndEvent(
                    session_id=session_id, message_id=msg_id,
                ))

    elif event_type == "message_stop":
        if stream_text_msg_id:
            if emit:
                await emit(StreamEndEvent(
                    session_id=session_id, message_id=stream_text_msg_id,
                ))

    return stream_text_msg_id