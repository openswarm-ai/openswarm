#!/usr/bin/env python3
"""
Stdio MCP server that exposes the InvokeAgent tool.

Launched as a subprocess by the Claude Agent SDK. Proxies invocation
requests to the OpenSwarm backend via HTTP, which forks the target
agent session and runs it with the new message.
"""

import json
import sys
import os
import urllib.request
import urllib.error

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/invoke-agent/run"
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")
DASHBOARD_ID = os.environ.get("OPENSWARM_DASHBOARD_ID", "")

TOOLS = [
    {
        "name": "InvokeAgent",
        "description": (
            "Invoke a copy of an existing agent session with a new message. "
            "The invoked agent will have full context of its prior conversation "
            "and will process the new message independently. Use this when you "
            "need to query another agent about its prior work or ask it to "
            "perform a follow-up task."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": (
                        "The session ID of the agent to invoke. This is the ID "
                        "from a selected Agent Card in the context."
                    ),
                },
                "message": {
                    "type": "string",
                    "description": (
                        "The message to send to the invoked agent. Be specific "
                        "about what you need from it."
                    ),
                },
            },
            "required": ["session_id", "message"],
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


def call_backend(session_id: str, message: str) -> dict:
    payload = json.dumps({
        "session_id": session_id,
        "message": message,
        "parent_session_id": PARENT_SESSION_ID,
        "dashboard_id": DASHBOARD_ID,
    }).encode()
    req = urllib.request.Request(
        BACKEND_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"error": str(e)}


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name != "InvokeAgent":
        return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}

    session_id = arguments.get("session_id", "")
    message = arguments.get("message", "")

    if not session_id:
        return {"content": [{"type": "text", "text": "Error: session_id is required"}], "isError": True}
    if not message:
        return {"content": [{"type": "text", "text": "Error: message is required"}], "isError": True}

    result = call_backend(session_id, message)

    if "error" in result:
        return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}

    forked_id = result.get("forked_session_id", "")
    response = result.get("response", "No response from invoked agent.")
    cost = result.get("cost_usd", 0)
    source_name = result.get("source_name", "")

    lines = [f"**Invoked Agent Result** (forked session: {forked_id})"]
    if source_name:
        lines[0] = f"**Invoked Agent Result** — {source_name} (forked session: {forked_id})"
    if cost > 0:
        lines.append(f"*Cost: ${cost:.4f}*")
    lines.append("")
    lines.append(response)

    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


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
                    "name": "openswarm-invoke-agent",
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
