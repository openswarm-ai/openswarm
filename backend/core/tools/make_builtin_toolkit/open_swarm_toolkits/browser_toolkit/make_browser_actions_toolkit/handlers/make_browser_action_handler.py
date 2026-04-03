import json
from typing import Dict, Any
from typeguard import typechecked

from backend.core.shared_structs.agent.Message.agent_outputs import ToolResponse
from backend.core.shared_structs.browser.BrowserCommandFn import BrowserCommandFn

ACTION_MAP: Dict[str, str] = {
    "BrowserScreenshot": "screenshot",
    "BrowserGetText": "get_text",
    "BrowserNavigate": "navigate",
    "BrowserClick": "click",
    "BrowserType": "type",
    "BrowserEvaluate": "evaluate",
    "BrowserGetElements": "get_elements",
    "BrowserScroll": "scroll",
    "BrowserWait": "wait",
}


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


@typechecked
def make_browser_action_handler(
    tool_name: str,
    browser_id: str,
    tab_id: str,
    send_command: BrowserCommandFn,
):
    action = ACTION_MAP.get(tool_name)

    async def handler(args: Dict[str, Any]) -> ToolResponse:
        if not action:
            return {"content": [{"type": "text", "text": f"Unknown browser tool: {tool_name}"}], "is_error": True}

        result = await send_command(action, browser_id, tab_id, args)

        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "is_error": True}
        return {"content": _format_tool_result(result, tool_name)}

    return handler
