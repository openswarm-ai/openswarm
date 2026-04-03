from typing import Dict, Any
from typeguard import typechecked
from backend.apps.HaikFix.Agent.shared_structs.Message.agent_outputs import ToolResponse
from backend.apps.agents.browser.executor import execute_browser_tool, _format_tool_result

@typechecked
def make_browser_action_handler(tool_name: str, browser_id: str, tab_id: str):
    async def handler(args: Dict[str, Any]) -> ToolResponse:
        result = await execute_browser_tool(tool_name, args, browser_id, tab_id)
        if "error" in result:
            return {
                "content": [
                    {
                        "type": "text",
                        "text": f"Error: {result['error']}",
                    },
                ],
                "is_error": True,
            }
        content_blocks = _format_tool_result(result, tool_name)
        return {"content": content_blocks}
    return handler
