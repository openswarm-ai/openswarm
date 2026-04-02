import time
from typing import Dict, List, Any

# NOTE: Hella dependancies, this baddddddd
# TODO: fix this shit cuh
from backend.apps.agents.browser.executor import execute_browser_tool, _format_tool_result

from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.utils.temp_sub_utils.model_ids import is_valid_model_id
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.utils.temp_sub_utils.model_ids import get_anthropic_client
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.utils.temp_sub_utils.schemas import BROWSER_TOOLS_SCHEMA, SYSTEM_PROMPT, MAX_TURNS

async def run_browser_loop(
    task: str,
    browser_id: str,
    model_id: str,
    initial_url: str | None = None,
    tab_id: str = "",
) -> Dict[str, Any]:
    """Run the browser agent tool loop against the Anthropic API directly."""

    if initial_url:
        await execute_browser_tool("BrowserNavigate", {"url": initial_url}, browser_id, tab_id)

    if not is_valid_model_id(model_id):
        raise ValueError(f"Invalid model ID: {model_id}")

    client = get_anthropic_client()

    messages: List[Dict] = [{"role": "user", "content": task}]
    action_log: List[Dict] = []
    final_screenshot: str | None = None
    last_text_parts: List[str] = []

    for _ in range(MAX_TURNS):
        response = await client.messages.create(
            model=f"cc/{model_id}",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=BROWSER_TOOLS_SCHEMA,
            messages=messages,
        )

        assistant_content = []
        last_text_parts = []
        tool_uses = []

        for block in response.content:
            if block.type == "text":
                last_text_parts.append(block.text)
                assistant_content.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                tool_uses.append(block)
                assistant_content.append({
                    "type": "tool_use", "id": block.id,
                    "name": block.name, "input": block.input,
                })

        messages.append({"role": "assistant", "content": assistant_content})

        if response.stop_reason != "tool_use":
            break

        tool_results = []
        for tu in tool_uses:
            start = time.time()
            result = await execute_browser_tool(tu.name, tu.input, browser_id, tab_id)
            elapsed_ms = int((time.time() - start) * 1000)
            action_log.append({
                "tool": tu.name,
                "input": tu.input,
                "elapsed_ms": elapsed_ms,
            })
            if tu.name == "BrowserScreenshot" and result.get("image"):
                final_screenshot = result["image"]
            content_blocks = _format_tool_result(result, tu.name)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tu.id,
                "content": content_blocks,
            })

        messages.append({"role": "user", "content": tool_results})

    if not final_screenshot:
        try:
            ss = await execute_browser_tool("BrowserScreenshot", {}, browser_id, tab_id)
            if ss.get("image"):
                final_screenshot = ss["image"]
        except Exception:
            pass

    return {
        "summary": "\n".join(last_text_parts) if last_text_parts else "Task completed.",
        "action_log": action_log,
        "final_screenshot": final_screenshot,
    }

