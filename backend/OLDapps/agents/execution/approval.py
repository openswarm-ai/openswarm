"""Unified HITL (human-in-the-loop) approval flow.

Used by both the main agent loop and browser sub-agents.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from uuid import uuid4

from backend.apps.agents.models import AgentSession, ApprovalRequest
from backend.apps.agents.manager.ws_manager import ws_manager

from backend.apps.analytics.collector import record as _analytics


logger = logging.getLogger(__name__)


async def request_approval(
    session: AgentSession,
    tool_name: str,
    tool_input: dict,
    timeout: float | None = None,
    track_analytics: bool = True,
) -> dict:
    """Unified HITL approval flow.

    Creates an ApprovalRequest, sends it via WebSocket, waits for the user's
    decision, cleans up, and returns the decision dict.

    Returns: {"behavior": "allow"|"deny", "message": ..., "updated_input": ...}
    """
    safe_input = tool_input if isinstance(tool_input, dict) else {}
    request_id = uuid4().hex
    approval_req = ApprovalRequest(
        id=request_id, session_id=session.id,
        tool_name=tool_name, tool_input=safe_input,
    )
    session.pending_approvals.append(approval_req)
    session.status = "waiting_approval"

    if track_analytics:
        _analytics("approval.requested", {
            "tool_name": tool_name,
            "is_first_approval_in_session": len(session.pending_approvals) == 1,
            "model": session.model,
        }, session_id=session.id, dashboard_id=session.dashboard_id)

    await ws_manager.emit_status(session.id, "waiting_approval")

    if timeout is not None:
        try:
            decision = await asyncio.wait_for(
                ws_manager.send_approval_request(session.id, request_id, tool_name, safe_input),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            decision = {"behavior": "deny", "message": "Approval timed out"}
    else:
        decision = await ws_manager.send_approval_request(
            session.id, request_id, tool_name, safe_input,
        )

    if track_analytics:
        latency_ms = int((datetime.now() - approval_req.created_at).total_seconds() * 1000)
        _analytics("approval.resolved", {
            "tool_name": tool_name,
            "decision": decision.get("behavior", "unknown"),
            "latency_ms": latency_ms,
            "input_was_modified": decision.get("updated_input") is not None,
            "model": session.model,
        }, session_id=session.id, dashboard_id=session.dashboard_id)

    session.pending_approvals = [a for a in session.pending_approvals if a.id != request_id]
    session.status = "running"
    await ws_manager.emit_status(session.id, "running")
    return decision
