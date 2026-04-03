#!/usr/bin/env python3
"""
Stdio MCP server that exposes BrowserAgent and BrowserAgents delegation tools.

Launched as a subprocess by the Claude Agent SDK. Proxies task delegation
to the OpenSwarm backend via HTTP, which runs browser sub-agents.
"""

import base64
import json
import sys
import os
import urllib.request
import urllib.error
from io import BytesIO

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

from browser_agent_mcp_schemas import TOOLS  # noqa: E402  (sibling script import)

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8325")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/agents/browser-agent/run"
MODEL = os.environ.get("OPENSWARM_AGENT_MODEL", "sonnet")
DASHBOARD_ID = os.environ.get("OPENSWARM_DASHBOARD_ID", "")
PRE_SELECTED_BROWSER_IDS = os.environ.get("OPENSWARM_PRE_SELECTED_BROWSER_IDS", "")
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")


def send_response(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def call_backend(tasks: list[dict]) -> dict:
    pre_selected = [bid.strip() for bid in PRE_SELECTED_BROWSER_IDS.split(",") if bid.strip()]
    payload = json.dumps({
        "tasks": tasks,
        "model": MODEL,
        "dashboard_id": DASHBOARD_ID,
        "pre_selected_browser_ids": pre_selected,
        "parent_session_id": PARENT_SESSION_ID,
    }).encode()
    req = urllib.request.Request(
        BACKEND_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"error": str(e)}


MAX_IMAGE_B64_BYTES = 400_000


def compress_screenshot(b64_png: str) -> tuple[str, str] | None:
    """Resize and re-encode as JPEG to stay under the stdio buffer limit."""
    if not HAS_PIL:
        return None
    try:
        raw = base64.b64decode(b64_png)
        img = Image.open(BytesIO(raw))
        max_width = 1024
        if img.width > max_width:
            ratio = max_width / img.width
            img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
        buf = BytesIO()
        img.convert("RGB").save(buf, format="JPEG", quality=45)
        return base64.b64encode(buf.getvalue()).decode(), "image/jpeg"
    except Exception:
        return None


def format_result(result: dict) -> dict:
    """Format a single browser agent result into MCP content blocks."""
    if "error" in result:
        return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}

    content = []

    summary = result.get("summary", "Task completed.")
    session_id = result.get("session_id", "")
    browser_id = result.get("browser_id", "")
    action_log = result.get("action_log", [])

    lines = [f"**Browser Agent Result** (browser: {browser_id}, session: {session_id})", ""]
    lines.append(f"**Summary:** {summary}")

    if action_log:
        lines.append("")
        lines.append("**Actions taken:**")
        for i, entry in enumerate(action_log, 1):
            tool = entry.get("tool", "?")
            inp = entry.get("input", {})
            ms = entry.get("elapsed_ms", 0)
            brief = json.dumps(inp)[:120]
            lines.append(f"  {i}. {tool}({brief}) [{ms}ms]")

    content.append({"type": "text", "text": "\n".join(lines)})

    screenshot = result.get("final_screenshot")
    if screenshot:
        image_data = screenshot
        mime_type = "image/png"

        if len(image_data) > MAX_IMAGE_B64_BYTES:
            compressed = compress_screenshot(image_data)
            if compressed:
                image_data, mime_type = compressed

        if len(image_data) <= MAX_IMAGE_B64_BYTES:
            content.append({"type": "image", "data": image_data, "mimeType": mime_type})
            content.append({"type": "text", "text": "Final screenshot attached above."})
        else:
            content.append({"type": "text", "text": "Final screenshot was too large to include."})

    return {"content": content}


def format_batch_results(results: list[dict]) -> dict:
    """Format multiple browser agent results."""
    if isinstance(results, dict) and "error" in results:
        return {"content": [{"type": "text", "text": f"Error: {results['error']}"}], "isError": True}

    all_content = []
    for i, result in enumerate(results):
        formatted = format_result(result)
        if i > 0:
            all_content.append({"type": "text", "text": f"\n---\n"})
        all_content.extend(formatted.get("content", []))

    return {"content": all_content}


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name == "CreateBrowserAgent":
        task_def = {
            "task": arguments.get("task", ""),
            "browser_id": "",
            "url": arguments.get("url", ""),
        }
        result = call_backend([task_def])
        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
        results = result.get("results", [result])
        if results:
            return format_result(results[0])
        return {"content": [{"type": "text", "text": "No result returned."}], "isError": True}

    elif tool_name == "BrowserAgent":
        browser_id = arguments.get("browser_id", "")
        if not browser_id:
            return {"content": [{"type": "text", "text": "Error: browser_id is required"}], "isError": True}
        task_def = {
            "task": arguments.get("task", ""),
            "browser_id": browser_id,
            "url": "",
        }
        result = call_backend([task_def])
        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
        results = result.get("results", [result])
        if results:
            return format_result(results[0])
        return {"content": [{"type": "text", "text": "No result returned."}], "isError": True}

    elif tool_name == "BrowserAgents":
        tasks = arguments.get("tasks", [])
        if not tasks:
            return {"content": [{"type": "text", "text": "Error: tasks array is empty"}], "isError": True}
        for t in tasks:
            if not t.get("browser_id"):
                return {"content": [{"type": "text", "text": "Error: browser_id is required for each task"}], "isError": True}
        result = call_backend(tasks)
        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
        results = result.get("results", [])
        return format_batch_results(results)

    return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method")
        id_ = msg.get("id")
        params = msg.get("params", {})

        if method == "initialize":
            send_response(id_, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "openswarm-browser-agent",
                    "version": "1.0.0",
                },
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            send_response(id_, {"tools": TOOLS})
        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})
            result = handle_tool_call(tool_name, arguments)
            send_response(id_, result)
        elif method == "ping":
            send_response(id_, {})
        elif id_ is not None:
            send_response(id_, error={"code": -32601, "message": f"Method not found: {method}"})


if __name__ == "__main__":
    main()
