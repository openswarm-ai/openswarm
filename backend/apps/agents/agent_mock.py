"""Mock agent and session-completed analytics.

Extracted from agent_loop.py to keep every file under 250 lines.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from uuid import uuid4

from backend.apps.agents.models import AgentSession, ApprovalRequest, Message
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.analytics.collector import record as _analytics

logger = logging.getLogger(__name__)


async def stream_text(session_id: str, msg_id: str, text: str, delay: float = 0.03):
    await ws_manager.emit_stream_start(session_id, msg_id, "assistant")
    words = text.split(" ")
    for i, word in enumerate(words):
        chunk = word if i == 0 else " " + word
        await ws_manager.emit_stream_delta(session_id, msg_id, chunk)
        await asyncio.sleep(delay)
    await ws_manager.emit_stream_end(session_id, msg_id)


async def stream_tool_input(session_id: str, msg_id: str, tool_name: str, input_json: str, delay: float = 0.02):
    await ws_manager.emit_stream_start(session_id, msg_id, "tool_call", tool_name=tool_name)
    chunk_size = 12
    for i in range(0, len(input_json), chunk_size):
        await ws_manager.emit_stream_delta(session_id, msg_id, input_json[i:i + chunk_size])
        await asyncio.sleep(delay)
    await ws_manager.emit_stream_end(session_id, msg_id)


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


async def run_mock_agent(session_id: str, prompt: str, sessions: dict[str, AgentSession]):
    session = sessions.get(session_id)
    if not session:
        return

    await asyncio.sleep(1)

    request_id = uuid4().hex
    approval_req = ApprovalRequest(
        id=request_id, session_id=session_id, tool_name="Bash",
        tool_input={"command": f"echo 'Processing: {prompt}'", "description": "Echo the user prompt"},
    )
    session.pending_approvals.append(approval_req)
    session.status = "waiting_approval"
    await ws_manager.emit_status(session_id, "waiting_approval")

    decision = await ws_manager.send_approval_request(
        session_id, request_id, "Bash",
        {"command": f"echo 'Processing: {prompt}'", "description": "Echo the user prompt"},
    )

    session.pending_approvals = [a for a in session.pending_approvals if a.id != request_id]
    session.status = "running"
    await ws_manager.emit_status(session_id, "running")

    tool_input_content = {"tool": "Bash", "input": {"command": f"echo 'Processing: {prompt}'"}, "approved": decision.get("behavior") == "allow"}
    tool_msg_id = uuid4().hex
    await stream_tool_input(session_id, tool_msg_id, "Bash", json.dumps(tool_input_content["input"], indent=2))
    tool_msg = Message(id=tool_msg_id, role="tool_call", content=tool_input_content, branch_id=session.active_branch_id)
    session.messages.append(tool_msg)
    await ws_manager.emit_message(session_id, tool_msg)

    await asyncio.sleep(1)

    if decision.get("behavior") == "allow":
        tool_result = Message(role="tool_result", content=f"Processing: {prompt}", branch_id=session.active_branch_id)
        session.messages.append(tool_result)
        await ws_manager.emit_message(session_id, tool_result)

    await asyncio.sleep(1)

    asst_text = (
        f"I've processed your request: \"{prompt}\"\n\n"
        "This is a mock response because `claude-agent-sdk` is not installed. "
        "Install it with `pip install claude-agent-sdk` to use real Claude Code instances.\n\n"
        f"The agent was configured with:\n- Model: {session.model}\n- Mode: {session.mode}"
    )
    asst_msg_id = uuid4().hex
    await stream_text(session_id, asst_msg_id, asst_text)

    asst_msg = Message(id=asst_msg_id, role="assistant", content=asst_text, branch_id=session.active_branch_id)
    session.messages.append(asst_msg)
    await ws_manager.emit_message(session_id, asst_msg)

    session.status = "completed"
    session.closed_at = datetime.now()
    session.cost_usd = 0.001
    await ws_manager.emit_status(session_id, "completed", session)
    await ws_manager.emit_cost_update(session_id, session.cost_usd)
