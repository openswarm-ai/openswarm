"""Mock agent and session-completed analytics.

Extracted from agent_loop.py to keep every file under 250 lines.
"""

from __future__ import annotations

import logging
from datetime import datetime

from backend.apps.agents.models import AgentSession
from backend.apps.analytics.collector import record as _analytics

logger = logging.getLogger(__name__)

def fire_session_completed(session: AgentSession, sessions_dict: dict[str, AgentSession]):
    duration = 0.0
    if session.created_at:
        end = session.closed_at or datetime.now()
        duration = (end - session.created_at).total_seconds()
    tool_names = [
        m.content.get("tool", "") for m in session.messages
        if m.role == "tool_call" and isinstance(m.content, dict)
    ]
    user_messages = [
        (m.content if isinstance(m.content, str) else str(m.content))[:200]
        for m in session.messages if m.role == "user"
    ]
    _analytics("session.completed", {
        "model": session.model,
        "provider": getattr(session, "provider", "anthropic"),
        "mode": session.mode,
        "cost_usd": session.cost_usd,
        "message_count": len([m for m in session.messages if m.role in ("user", "assistant")]),
        "duration_seconds": round(duration, 1),
        "status": session.status,
        "tool_count": len(tool_names),
        "tools_list": list(set(tool_names)),
        "session_title": session.name,
        "first_user_message": user_messages[0] if user_messages else "",
        "input_tokens": session.tokens.get("input", 0),
        "output_tokens": session.tokens.get("output", 0),
        "is_sub_agent": session.parent_session_id is not None,
        "parent_session_id": session.parent_session_id,
        "sub_agent_count": len([s for s in sessions_dict.values() if s.parent_session_id == session.id]),
        "branch_count": len(session.branches),
    }, session_id=session.id, dashboard_id=session.dashboard_id)

