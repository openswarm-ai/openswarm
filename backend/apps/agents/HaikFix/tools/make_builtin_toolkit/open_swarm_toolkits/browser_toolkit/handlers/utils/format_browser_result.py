import json
from typing import Dict, List, Any

from backend.apps.agents.HaikFix.Agent.shared_structs.Message.agent_outputs import ToolResponse

MAX_IMAGE_B64_BYTES = 400_000

def format_browser_result(result: Dict[str, Any], browser_id: str) -> ToolResponse:
    """Format the browser loop result into a ToolResponse."""
    lines = [
        f"**Browser Agent Result** (browser: {browser_id})",
        "",
        f"**Summary:** {result['summary']}",
    ]

    if result["action_log"]:
        lines.append("")
        lines.append("**Actions taken:**")
        for i, entry in enumerate[Any](result["action_log"], 1):
            tool = entry["tool"]
            inp = json.dumps(entry.get("input", {}))[:120]
            ms = entry.get("elapsed_ms", 0)
            lines.append(f"  {i}. {tool}({inp}) [{ms}ms]")

    content: List[Dict[str, str]] = [{"type": "text", "text": "\n".join(lines)}]

    screenshot = result.get("final_screenshot")
    if screenshot and len(screenshot) <= MAX_IMAGE_B64_BYTES:
        content.append({"type": "image", "data": screenshot, "mimeType": "image/png"})

    return {"content": content}