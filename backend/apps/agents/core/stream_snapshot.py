"""The text of an assistant reply that is streaming RIGHT NOW, for a session socket that just connected.

Every delta before the per-session socket connects is lost to that client: the ring replays them, but
the client drops replayed stream frames on purpose (they predate its resume ack). Until now the
transcript stayed on a static "Thinking..." and then received the whole reply at once, which is the
"streams halfway, wipes, then retypes everything fast" Eric kept seeing. The manager already keeps the
accumulated text per session (`live_partial`, for the crash snapshot); this hands it to the socket.
"""

from typing import Dict, Optional

from typeguard import typechecked

from backend.apps.agents.manager.streaming.PartialReply import PartialReply


@typechecked
def stream_snapshot_payload(
    session_id: str,
    live_partial: Dict[str, PartialReply],
    live_thinking: Optional[Dict[str, PartialReply]] = None,
) -> Optional[dict]:
    # The answer wins over the thought: once text is flowing the thinking block is over.
    partial = live_partial.get(session_id)
    role = "assistant"
    if partial is None or not partial.msg_id or not partial.text:
        partial = (live_thinking or {}).get(session_id)
        role = "thinking"
    if partial is None or not partial.msg_id or not partial.text:
        return None
    return {
        "session_id": session_id,
        "message_id": partial.msg_id,
        "role": role,
        "text": partial.text,
    }
