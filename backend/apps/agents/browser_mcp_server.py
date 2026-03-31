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

from browser_mcp_schemas import TOOLS  # noqa: E402  (sibling script import)

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8325")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/agents/browser/command"


def send_response(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
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
