#!/usr/bin/env python3
"""Stdio MCP server exposing InvokeAgent and ReadAgentWork.

ReadAgentWork exists because the only way a parent had to learn what a child did was to ASK THE
CHILD MODEL TO SAY IT AGAIN, which is structurally a reproduction request on a lane whose filter is
looking for exactly that: delegation-bearing chats block at 13.0% against a 2.7% baseline (ENG-389).
We already store every child's messages, so the parent reads the record instead of interviewing the
model, and the extraction-shaped prompt is never written at all."""

import json
import sys
import os
import urllib.request
import urllib.error

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/invoke-agent/run"
WORK_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/agents/sessions/{{}}/work"
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")
DASHBOARD_ID = os.environ.get("OPENSWARM_DASHBOARD_ID", "")

TOOLS = [
    {
        "name": "InvokeAgent",
        "description": (
            "Give an existing agent session NEW work: it runs the message with full context of "
            "its prior conversation and reports back. Use this to ask another agent to DO "
            "something. To find out what it already did, use ReadAgentWork: it reads this app's "
            "stored record directly and costs no model turn."
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
    {
        "name": "ReadAgentWork",
        "description": (
            "Read what another agent session actually did: the requests it was given, the tools it "
            "ran with their results, and the answer it finished on. Read straight from this app's "
            "own stored record, so it costs no model turn and works even if that agent is busy, "
            "stopped, or errored out. Use this for any 'what did it do / what did it find / where "
            "did it get to' question about another session."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "The session ID to read, from a selected Agent Card in the context.",
                },
            },
            "required": ["session_id"],
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
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"error": str(e)}


def read_work(session_id: str) -> dict:
    headers = {"Authorization": f"Bearer {BACKEND_AUTH}"} if BACKEND_AUTH else {}
    req = urllib.request.Request(WORK_URL.format(session_id), headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"error": str(e)}


def handle_read_agent_work(arguments: dict) -> dict:
    session_id = arguments.get("session_id", "")
    if not session_id:
        return {"content": [{"type": "text", "text": "Error: session_id is required"}], "isError": True}
    result = read_work(session_id)
    if "error" in result:
        return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
    head = f"**{result.get('name') or 'Agent'}** (session {session_id}, status: {result.get('status', 'unknown')})"
    trail = result.get("work") or ""
    if not trail.strip():
        return {"content": [{"type": "text", "text": f"{head}\n\nThat session has not done any work yet."}]}
    return {"content": [{"type": "text", "text": f"{head}\n\n{trail}"}]}


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name == "ReadAgentWork":
        return handle_read_agent_work(arguments)
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
        lines[0] = f"**Invoked Agent Result**; {source_name} (forked session: {forked_id})"
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
