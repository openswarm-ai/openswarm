#!/usr/bin/env python3
"""Stdio MCP module letting an agent rearrange the canvas AFTER spawn (ENG-334).

One tool, CanvasCommand, backed by /api/canvas/command, which relays to the
renderer over the browser-command bridge. Placement at spawn already existed;
this adds move/collapse/expand/tile/close/tidy so an agent can park its browser
next to its chat, shrink itself when done, or clean up a helper card it opened.
Close is enforced server-side to the caller's own card or cards it spawned."""

import json
import os
import sys
import urllib.error
import urllib.request

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/canvas/command"
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")
DASHBOARD_ID = os.environ.get("OPENSWARM_DASHBOARD_ID", "")

TOOLS = [
    {
        "name": "CanvasCommand",
        "description": (
            "Control cards on the user's canvas after they exist: move a card, collapse or "
            "expand it, tile it to a screen zone, close it, or tidy the whole board. "
            "card_id defaults to YOUR own chat card; use a browser card's id (from "
            "CreateBrowserAgent) or a child session id to control cards you spawned. "
            "Closing is limited to your own card and cards you spawned. Use this sparingly "
            "and purposefully: the canvas belongs to the user, so rearrange only when it "
            "clearly helps the task (e.g. tuck your browser beside your chat, close a "
            "helper you no longer need, tidy after spawning several cards)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["move", "collapse", "expand", "tile", "close", "tidy"],
                    "description": "What to do. tidy reflows every card on the board and ignores card_id.",
                },
                "card_id": {
                    "type": "string",
                    "description": "Target card: an agent session id, browser card id, app/view card id, or workflow card id. Defaults to your own card.",
                },
                "x": {"type": "number", "description": "move only: canvas x."},
                "y": {"type": "number", "description": "move only: canvas y."},
                "zone": {
                    "type": "string",
                    "enum": ["fill", "left", "right", "top", "bottom", "tl", "tr", "bl", "br", "fullscreen", "restore"],
                    "description": "tile only: which screen zone; restore un-tiles.",
                },
            },
            "required": ["action"],
            "additionalProperties": False,
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


def call_backend(payload: dict) -> dict:
    full = {**payload, "parent_session_id": PARENT_SESSION_ID, "dashboard_id": DASHBOARD_ID}
    body = json.dumps(full).encode()
    headers = {"Content-Type": "application/json"}
    if BACKEND_AUTH:
        headers["Authorization"] = f"Bearer {BACKEND_AUTH}"
    req = urllib.request.Request(BACKEND_URL, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {detail}"}
    except Exception as e:
        return {"error": str(e)}


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name != "CanvasCommand":
        return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}
    action = str(arguments.get("action") or "").strip()
    if not action:
        return {"content": [{"type": "text", "text": "Error: `action` is required."}], "isError": True}
    payload = {
        "action": action,
        "card_id": str(arguments.get("card_id") or ""),
    }
    if arguments.get("x") is not None:
        payload["x"] = arguments.get("x")
    if arguments.get("y") is not None:
        payload["y"] = arguments.get("y")
    if arguments.get("zone"):
        payload["zone"] = str(arguments.get("zone"))
    result = call_backend(payload)
    if isinstance(result, dict) and result.get("error"):
        return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
    text = result.get("text") if isinstance(result, dict) else None
    return {"content": [{"type": "text", "text": str(text or "Done.")}]}


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
                "serverInfo": {"name": "openswarm-canvas", "version": "1.0.0"},
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            send_response(id_, {"tools": TOOLS})
        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})
            try:
                send_response(id_, handle_tool_call(tool_name, arguments))
            except Exception as e:
                send_response(id_, error={"code": -32000, "message": str(e)})
        elif method == "resources/list":
            send_response(id_, {"resources": []})
        elif method == "prompts/list":
            send_response(id_, {"prompts": []})
        elif id_ is not None:
            send_response(id_, error={"code": -32601, "message": f"Method not found: {method}"})


if __name__ == "__main__":
    main()
