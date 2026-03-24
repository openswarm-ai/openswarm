#!/usr/bin/env python3
"""
Minimal stdio MCP server that exposes browser interaction tools.

Launched as a subprocess by the Claude Agent SDK. Proxies tool calls
to the OpenSwarm backend via HTTP, which bridges them to the Electron
frontend via WebSocket where the actual webview lives.
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

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/browser/command"

TAB_ID_PROP = {
    "type": "string",
    "description": "Optional tab ID within the browser card. If omitted, targets the active tab.",
}

TOOLS = [
    {
        "name": "BrowserScreenshot",
        "description": (
            "Capture a screenshot of the browser page. Returns the screenshot as a "
            "base64-encoded PNG image. Use this to see what is currently displayed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The browser card ID to capture. Use the ID from the selected browser card context.",
                },
                "tab_id": TAB_ID_PROP,
            },
            "required": ["browser_id"],
        },
    },
    {
        "name": "BrowserGetText",
        "description": (
            "Get the visible text content of the browser page. Returns the page's "
            "innerText (up to 15000 characters)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The browser card ID.",
                },
                "tab_id": TAB_ID_PROP,
            },
            "required": ["browser_id"],
        },
    },
    {
        "name": "BrowserNavigate",
        "description": "Navigate the browser to a URL.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The browser card ID.",
                },
                "tab_id": TAB_ID_PROP,
                "url": {
                    "type": "string",
                    "description": "The URL to navigate to.",
                },
            },
            "required": ["browser_id", "url"],
        },
    },
    {
        "name": "BrowserClick",
        "description": (
            "Click an element in the browser page identified by a CSS selector."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The browser card ID.",
                },
                "tab_id": TAB_ID_PROP,
                "selector": {
                    "type": "string",
                    "description": "CSS selector of the element to click.",
                },
            },
            "required": ["browser_id", "selector"],
        },
    },
    {
        "name": "BrowserType",
        "description": (
            "Type text into an input element in the browser page. Clears the "
            "existing value first, then types the new text."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The browser card ID.",
                },
                "tab_id": TAB_ID_PROP,
                "selector": {
                    "type": "string",
                    "description": "CSS selector of the input element.",
                },
                "text": {
                    "type": "string",
                    "description": "The text to type.",
                },
            },
            "required": ["browser_id", "selector", "text"],
        },
    },
    {
        "name": "BrowserEvaluate",
        "description": (
            "Evaluate a JavaScript expression in the browser page and return the result. "
            "The expression is run via executeJavaScript on the webview."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The browser card ID.",
                },
                "tab_id": TAB_ID_PROP,
                "expression": {
                    "type": "string",
                    "description": "JavaScript expression to evaluate.",
                },
            },
            "required": ["browser_id", "expression"],
        },
    },
    {
        "name": "BrowserGetElements",
        "description": (
            "Get a list of interactive elements on the page with their CSS selectors. "
            "Returns clickable elements, inputs, links, and buttons with selector paths "
            "you can use with BrowserClick and BrowserType. Call this BEFORE attempting "
            "to click or type so you know which selectors are valid."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The browser card ID.",
                },
                "tab_id": TAB_ID_PROP,
                "selector": {
                    "type": "string",
                    "description": (
                        "Optional CSS selector to scope the search "
                        "(e.g. 'form', '#main'). Defaults to 'body'."
                    ),
                },
            },
            "required": ["browser_id"],
        },
    },
    {
        "name": "BrowserScroll",
        "description": (
            "Scroll the page up or down. Automatically finds the correct scrollable "
            "container (works on SPAs like Notion, Gmail, etc. that use nested scroll "
            "containers instead of window-level scrolling). Returns scroll position info "
            "including whether top/bottom has been reached."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The browser card ID.",
                },
                "tab_id": TAB_ID_PROP,
                "direction": {
                    "type": "string",
                    "enum": ["up", "down"],
                    "description": "Scroll direction. Defaults to 'down'.",
                },
                "amount": {
                    "type": "number",
                    "description": "Pixels to scroll. Defaults to 500.",
                },
            },
            "required": ["browser_id"],
        },
    },
    {
        "name": "BrowserWait",
        "description": (
            "Wait for a specified duration. Useful after navigation or actions that "
            "trigger page loads, animations, or async content rendering. "
            "Min 100ms, max 10000ms."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "browser_id": {
                    "type": "string",
                    "description": "The browser card ID.",
                },
                "tab_id": TAB_ID_PROP,
                "milliseconds": {
                    "type": "number",
                    "description": "Duration to wait in milliseconds. Defaults to 1000.",
                },
            },
            "required": ["browser_id"],
        },
    },
]


def send_response(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def send_notification(method, params=None):
    msg = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        msg["params"] = params
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def call_backend(action: str, browser_id: str, params: dict | None = None, tab_id: str = "") -> dict:
    payload = json.dumps({
        "action": action,
        "browser_id": browser_id,
        "tab_id": tab_id,
        "params": params or {},
    }).encode()
    req = urllib.request.Request(
        BACKEND_URL,
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


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    browser_id = arguments.get("browser_id", "")
    tab_id = arguments.get("tab_id", "")
    if not browser_id:
        return {"content": [{"type": "text", "text": "Error: browser_id is required"}], "isError": True}

    action_map = {
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
    action = action_map.get(tool_name)
    if not action:
        return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}

    params = {k: v for k, v in arguments.items() if k not in ("browser_id", "tab_id")}
    result = call_backend(action, browser_id, params, tab_id=tab_id)

    if "error" in result:
        return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}

    if action == "screenshot" and result.get("image"):
        image_data = result["image"]
        mime_type = "image/png"

        if len(image_data) > MAX_IMAGE_B64_BYTES:
            compressed = compress_screenshot(image_data)
            if compressed:
                image_data, mime_type = compressed

        if len(image_data) > MAX_IMAGE_B64_BYTES:
            return {
                "content": [
                    {"type": "text", "text": (
                        f"Screenshot too large to return ({len(image_data)} bytes base64). "
                        f"URL: {result.get('url', 'unknown')}. "
                        "Use BrowserGetText to read the page content instead."
                    )},
                ],
            }

        return {
            "content": [
                {"type": "image", "data": image_data, "mimeType": mime_type},
                {"type": "text", "text": f"Screenshot captured. URL: {result.get('url', 'unknown')}"},
            ],
        }

    text = result.get("text", result.get("data", json.dumps(result)))
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
                    "name": "openswarm-browser",
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
