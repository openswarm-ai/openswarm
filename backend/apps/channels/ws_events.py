"""WebSocket event emitters for channel events.

Uses the existing ws_manager.broadcast_global() — no new WebSocket
infrastructure needed.
"""
import logging
from backend.apps.agents.ws_manager import ws_manager

logger = logging.getLogger(__name__)


async def emit_channel_message(
    channel_id: str, conversation_id: str, message: dict
):
    await ws_manager.broadcast_global("channel:message", {
        "channel_id": channel_id,
        "conversation_id": conversation_id,
        "message": message,
    })


async def emit_channel_status(
    channel_id: str, status: str, detail: str = ""
):
    await ws_manager.broadcast_global("channel:status", {
        "channel_id": channel_id,
        "status": status,
        "detail": detail,
    })


async def emit_call_event(
    channel_id: str, call_sid: str, event: str, data: dict | None = None
):
    await ws_manager.broadcast_global("channel:call_event", {
        "channel_id": channel_id,
        "call_sid": call_sid,
        "event": event,
        **(data or {}),
    })
