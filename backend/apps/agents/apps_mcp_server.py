#!/usr/bin/env python3
"""Stdio MCP server letting ANY agent create an OpenSwarm App on the canvas.

One tool, CreateApp, backed by /api/outputs/agent-create. Always on, no
activation gate: app-building is a core capability, not a third-party MCP.
The backend seeds a React/Vite workspace, registers the App, links it to the
calling session, and drops a live preview card next to the agent on the
dashboard. The tool result hands back the workspace path + the full App
Builder reference so the agent can start writing code immediately."""

import json
import os
import sys
import urllib.error
import urllib.request

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/outputs"
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")


TOOLS = [
    {
        "name": "CreateApp",
        "description": (
            "Create a new OpenSwarm App: a real React 18 + TypeScript + Vite web app "
            "(optional FastAPI backend) that appears as a live preview card on the "
            "user's dashboard, next to you. Use this whenever the user asks you to "
            "build/make an app, tool, game, dashboard, tracker, visualizer, or any "
            "interactive UI. Returns the workspace path to write code in plus the "
            "App Builder reference (stack, layout, rules) — follow it. To EDIT an "
            "app that already exists, don't call this; edit its workspace files "
            "directly (the path is in your context when the user selects the app, "
            "and the preview hot-reloads on save)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Short human title for the app, e.g. 'Pomodoro Timer'.",
                },
                "description": {
                    "type": "string",
                    "description": "One sentence on what the app does.",
                },
            },
            "required": ["name"],
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


def call_backend(action: str, payload: dict) -> dict:
    full = {**payload, "parent_session_id": PARENT_SESSION_ID}
    body = json.dumps(full).encode()
    headers = {"Content-Type": "application/json"}
    if BACKEND_AUTH:
        headers["Authorization"] = f"Bearer {BACKEND_AUTH}"
    req = urllib.request.Request(
        f"{BACKEND_URL}/{action}", data=body, headers=headers, method="POST"
    )
    try:
        # Seeding copies the template + links the warm node_modules cache; give it room.
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {detail}"}
    except Exception as e:
        return {"error": str(e)}


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name == "CreateApp":
        name = str(arguments.get("name") or "").strip()
        if not name:
            return {"content": [{"type": "text", "text": "Error: `name` is required."}], "isError": True}
        result = call_backend("agent-create", {
            "name": name,
            "description": str(arguments.get("description") or "").strip(),
        })
        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
        path = result.get("path")
        # Point at SKILL.md instead of inlining the ~6.5k-token reference: it's written to the workspace at seed time, so a one-time Read keeps it out of the transcript (where an inline copy would rot for the rest of the session). Read it BEFORE building.
        lines = [
            f"App '{name}' created and its live preview card is now on the user's dashboard.",
            f"- workspace: {path}",
            f"- output_id: {result.get('output_id')}",
            "",
            f"NEXT: read {path}/SKILL.md now — it's the full App Builder reference (stack, layout, rules); follow it.",
            "Then build by writing files under the workspace path; the preview hot-reloads on save.",
            "Housekeeping: write meta.json (name/description) first; `bash restart.sh` restarts the runtime; `.openswarm/terminal.log` is the live terminal (check it before declaring done).",
        ]
        return {"content": [{"type": "text", "text": "\n".join(lines)}]}

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
                "serverInfo": {"name": "openswarm-apps", "version": "1.0.0"},
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
