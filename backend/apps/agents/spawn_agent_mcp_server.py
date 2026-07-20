#!/usr/bin/env python3
"""Stdio MCP server exposing the SpawnAgent tool; proxies to /api/spawn-agent/run.

Replaces the CLI's built-in Agent tool (blocked in RunOptions): that schema drags
description/subagent_type/model/isolation along, and its subagent types resolve to
models our router setups can't serve. This one takes prompt + run_in_background,
nothing else; the child runs as a real OpenSwarm session card on the dashboard."""

import json
import sys
import os
import urllib.request
import urllib.error

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/spawn-agent/run"
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")
DASHBOARD_ID = os.environ.get("OPENSWARM_DASHBOARD_ID", "")

TOOLS = [
    {
        "name": "SpawnAgent",
        "description": (
            "Spawn a sub-agent to handle a task. The sub-agent runs as its own "
            "agent session (visible on the dashboard) with the same working "
            "directory and model as you. By default this blocks until the "
            "sub-agent finishes and returns its final answer; set "
            "run_in_background=true to return immediately and let it work on "
            "its own, its progress and result appear on its dashboard card."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": (
                        "The task for the sub-agent. Include all context it "
                        "needs; it does not see your conversation."
                    ),
                },
                "run_in_background": {
                    "type": "boolean",
                    "description": (
                        "true = return immediately with the sub-agent's session "
                        "id instead of waiting for its result."
                    ),
                },
            },
            "required": ["prompt"],
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


def call_backend(prompt: str, run_in_background: bool) -> dict:
    payload = json.dumps({
        "prompt": prompt,
        "run_in_background": run_in_background,
        "parent_session_id": PARENT_SESSION_ID,
        "dashboard_id": DASHBOARD_ID,
    }).encode()
    headers = {"Content-Type": "application/json"}
    if BACKEND_AUTH:
        headers["Authorization"] = f"Bearer {BACKEND_AUTH}"
    req = urllib.request.Request(
        BACKEND_URL,
        data=payload,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=1800) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"error": str(e)}


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name != "SpawnAgent":
        return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}

    prompt = arguments.get("prompt", "")
    run_in_background = bool(arguments.get("run_in_background", False))

    if not prompt:
        return {"content": [{"type": "text", "text": "Error: prompt is required"}], "isError": True}

    result = call_backend(prompt, run_in_background)

    if "error" in result:
        return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}

    sid = result.get("session_id", "")
    if run_in_background:
        return {"content": [{"type": "text", "text": (
            f"Spawned background sub-agent (session: {sid}). It is working on its own "
            "dashboard card; its result will appear there. Do not wait for it."
        )}]}

    response = result.get("response", "No response from sub-agent.")
    cost = result.get("cost_usd", 0)
    lines = [f"**Sub-Agent Result** (session: {sid})"]
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
                    "name": "openswarm-spawn-agent",
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
