"""Browser tool execution and approval helpers."""

from __future__ import annotations

import json
import logging
from uuid import uuid4

from backend.apps.agents.models import AgentSession
from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.agents.execution.approval import request_approval
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
    return await request_approval(
        session, tool_name, tool_input, timeout=300.0, track_analytics=False,
    )
