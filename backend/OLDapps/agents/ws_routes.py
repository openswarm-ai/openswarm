"""WebSocket message dispatch logic.

Extracted from main.py to keep it slim.  The main.py WebSocket handlers
are thin wrappers that delegate here after JSON-parsing the message.
"""

from __future__ import annotations

import logging

from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.agents.manager.agent_manager import agent_manager

logger = logging.getLogger(__name__)

async def handle_session_message(session_id: str, event: str, payload: dict):
    """Dispatch an incoming WebSocket message for a session."""
    if event == "agent:send_message":
        await agent_manager.send_message(
            session_id,
            payload.get("prompt", ""),
            mode=payload.get("mode"),
            model=payload.get("model"),
            provider=payload.get("provider"),
            images=payload.get("images"),
        )
    elif event == "agent:approval_response":
        agent_manager.handle_approval(payload.get("request_id"), {
            "behavior": payload.get("behavior", "deny"),
            "message": payload.get("message"),
            "updated_input": payload.get("updated_input"),
        })
    elif event == "agent:edit_message":
        await agent_manager.edit_message(
            session_id,
            payload.get("message_id", ""),
            payload.get("content", ""),
        )
    elif event == "agent:stop":
        await agent_manager.stop_agent(session_id)

async def handle_dashboard_message(event: str, payload: dict):
    """Dispatch an incoming WebSocket message for the dashboard."""
    if event == "agent:approval_response":
        agent_manager.handle_approval(payload.get("request_id"), {
            "behavior": payload.get("behavior", "deny"),
            "message": payload.get("message"),
            "updated_input": payload.get("updated_input"),
        })
    elif event == "browser:result":
        ws_manager.resolve_browser_command(
            payload.get("request_id", ""),
            payload,
        )
