"""Browser tool execution and approval helpers."""

from __future__ import annotations

import asyncio
import json
import logging
from uuid import uuid4

from backend.apps.agents.models import AgentSession, ApprovalRequest
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.agents.browser.schemas import ACTION_MAP

logger = logging.getLogger(__name__)


async def execute_browser_tool(
    tool_name: str, tool_input: dict, browser_id: str, tab_id: str = "",
) -> dict:
    action = ACTION_MAP.get(tool_name)
    if not action:
        return {"error": f"Unknown browser tool: {tool_name}"}
    params = {k: v for k, v in tool_input.items()}
    request_id = uuid4().hex
    result = await ws_manager.send_browser_command(
        request_id, action, browser_id, params, tab_id=tab_id,
    )
    return result


def _format_tool_result(result: dict, tool_name: str) -> list[dict]:
    if "error" in result:
        return [{"type": "text", "text": f"Error: {result['error']}"}]
    if tool_name == "BrowserScreenshot" and result.get("image"):
        return [
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": result["image"]},
            },
            {"type": "text", "text": f"Screenshot captured. URL: {result.get('url', 'unknown')}"},
        ]
    text = result.get("text", json.dumps(result))
    return [{"type": "text", "text": str(text)}]


async def _request_browser_approval(
    session: AgentSession, tool_name: str, tool_input: dict,
) -> dict:
    request_id = uuid4().hex
    approval_req = ApprovalRequest(
        id=request_id, session_id=session.id,
        tool_name=tool_name, tool_input=tool_input,
    )
    session.pending_approvals.append(approval_req)
    session.status = "waiting_approval"
    await ws_manager.send_to_session(session.id, "agent:status", {
        "session_id": session.id, "status": "waiting_approval",
    })
    try:
        decision = await asyncio.wait_for(
            ws_manager.send_approval_request(session.id, request_id, tool_name, tool_input),
            timeout=300.0,
        )
    except asyncio.TimeoutError:
        decision = {"behavior": "deny", "message": "Approval timed out"}
    session.pending_approvals = [a for a in session.pending_approvals if a.id != request_id]
    session.status = "running"
    await ws_manager.send_to_session(session.id, "agent:status", {
        "session_id": session.id, "status": "running",
    })
    return decision
