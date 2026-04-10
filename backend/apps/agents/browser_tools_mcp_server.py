#!/usr/bin/env python3
"""
Stdio MCP server that exposes the 9 low-level browser tools as MCP tools.

Used by claude_agent_sdk when running browser agents through CLI (no API key).
Each tool call proxies to the backend's /api/browser/command HTTP endpoint,
which forwards the command to the frontend browser card via WebSocket.
"""

import json
import os
import sys
import urllib.request
import urllib.error

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BROWSER_ID = os.environ.get("OPENSWARM_BROWSER_ID", "")
COMMAND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/browser/command"

TOOLS = [
    {
        "name": "BrowserScreenshot",
        "description": (
            "Capture a screenshot of the browser page. Returns the screenshot as a "
            "base64-encoded PNG image. Use this to see what is currently displayed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "BrowserGetText",
        "description": (
            "Get the visible text content of the browser page. Returns up to 15000 characters."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "BrowserNavigate",
        "description": "Navigate the browser to a specific URL.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to navigate to.",
                },
            },
            "required": ["url"],
        },
    },
    {
        "name": "BrowserClick",
        "description": (
            "Click an element on the page identified by a CSS selector. "
            "Use BrowserGetElements first to find valid selectors."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "CSS selector for the element to click.",
                },
            },
            "required": ["selector"],
        },
    },
    {
        "name": "BrowserType",
        "description": (
            "Type text into an input element identified by a CSS selector. "
            "Optionally clear existing content first."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "CSS selector for the input element.",
                },
                "text": {
                    "type": "string",
                    "description": "The text to type.",
                },
                "clear": {
                    "type": "boolean",
                    "description": "Clear existing content before typing. Defaults to true.",
                },
            },
            "required": ["selector", "text"],
        },
    },
    {
        "name": "BrowserEvaluate",
        "description": (
            "Execute JavaScript code in the browser page and return the result. "
            "The last expression value is returned as a string."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "JavaScript code to execute in the page context.",
                },
            },
            "required": ["expression"],
        },
    },
    {
        "name": "BrowserGetElements",
        "description": (
            "Query DOM elements matching a CSS selector. Returns tag name, text, "
            "attributes, and bounding box for each match (up to 50 elements)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "CSS selector to query elements.",
                },
            },
            "required": ["selector"],
        },
    },
    {
        "name": "BrowserScroll",
        "description": (
            "Scroll the browser page. Can scroll up, down, or to a specific element. "
            "Returns scroll position info including whether you're at the top or bottom."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "direction": {
                    "type": "string",
                    "enum": ["up", "down"],
                    "description": "Direction to scroll. Ignored if 'selector' is provided.",
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector of element to scroll into view.",
                },
                "amount": {
                    "type": "number",
                    "description": "Pixels to scroll. Defaults to one viewport height.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "BrowserWait",
        "description": (
            "Wait for a specified duration. Use after navigation or actions that "
            "trigger page loads. Min 100ms, max 10000ms."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "milliseconds": {
                    "type": "number",
                    "description": "Duration to wait in milliseconds. Defaults to 1000.",
                },
            },
            "required": [],
        },
    },
]

# Map tool names to backend action names (matches browser_agent.py ACTION_MAP)
ACTION_MAP = {
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


def send_response(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def call_browser_command(action: str, params: dict) -> dict:
    """Send a browser command to the backend HTTP endpoint."""
    payload = json.dumps({
        "action": action,
        "browser_id": BROWSER_ID,
        "params": params,
    }).encode()
    req = urllib.request.Request(
        COMMAND_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"error": str(e)}


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    action = ACTION_MAP.get(tool_name)
    if not action:
        return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}

    result = call_browser_command(action, arguments)

    if "error" in result:
        return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}

    # Handle screenshot results — return as image content block
    if tool_name == "BrowserScreenshot" and result.get("image"):
        content = [
            {"type": "image", "data": result["image"], "mimeType": "image/png"},
            {"type": "text", "text": f"Screenshot captured. URL: {result.get('url', 'unknown')}"},
        ]
        return {"content": content}

    # All other results — return as text
    text = result.get("text", json.dumps(result))
    return {"content": [{"type": "text", "text": str(text)}]}


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
                    "name": "openswarm-browser-tools",
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
