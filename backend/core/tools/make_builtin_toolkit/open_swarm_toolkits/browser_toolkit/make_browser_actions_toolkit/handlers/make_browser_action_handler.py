import json
from typing import Dict, Any
from typeguard import typechecked

from backend.core.shared_structs.agent.Message.agent_outputs import ToolResponse
from backend.core.shared_structs.browser.BrowserCommandFn import BrowserCommandFn


@typechecked
def p_format_tool_result(result: dict, action: str) -> list[dict]:
    if "error" in result:
        return [{"type": "text", "text": f"Error: {result['error']}"}]
    if action == "screenshot" and result.get("image"):
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
    action: str,
    browser_id: str,
    tab_id: str,
    send_command: BrowserCommandFn,
):
    async def handler(args: Dict[str, Any]) -> ToolResponse:
        result = await send_command(action, browser_id, tab_id, args)

        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "is_error": True}
        return {"content": p_format_tool_result(result, action)}

    return handler
