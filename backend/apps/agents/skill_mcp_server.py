#!/usr/bin/env python3
"""Stdio MCP server exposing the Skill tool: loads an installed skill's instructions on demand."""

import json
import os
import sys
import urllib.error
import urllib.request

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
LOAD_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/skills/load"

TOOLS = [
    {
        "name": "Skill",
        "description": (
            "Load the full instructions for an installed skill by its id (the ids "
            "are listed in the <skills> block of your system prompt). Returns the "
            "skill's SKILL.md body plus a note about any supporting files it bundles. "
            "Call this when the user's request matches a listed skill, then follow "
            "the loaded instructions."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "The skill id from the <skills> catalog (e.g. 'deep-research').",
                },
            },
            "required": ["id"],
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


def p_post(url: str, body: dict, timeout: float = 30.0) -> dict:
    payload = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if BACKEND_AUTH:
        headers["Authorization"] = f"Bearer {BACKEND_AUTH}"
    req = urllib.request.Request(
        url,
        data=payload,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_txt = e.read().decode(errors="replace") if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body_txt[:500]}"}
    except Exception as e:
        return {"error": str(e)}


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name == "Skill":
        skill_id = str(arguments.get("id", "")).strip()
        if not skill_id:
            return {"content": [{"type": "text", "text": "Error: id is required"}], "isError": True}
        r = p_post(LOAD_URL, {"id": skill_id})
        if "error" in r:
            return {"content": [{"type": "text", "text": f"Failed to load skill: {r['error']}"}], "isError": True}
        if not r.get("ok"):
            available = r.get("available", [])
            hint = ", ".join(available) if available else "none installed"
            return {"content": [{"type": "text", "text": f"No skill with id {skill_id!r}. Installed skill ids: {hint}."}], "isError": True}
        return {"content": [{"type": "text", "text": r.get("text", "")}]}

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
        params = msg.get("params", {}) or {}

        if method == "initialize":
            send_response(id_, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "openswarm-skill",
                    "version": "1.0.0",
                },
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            send_response(id_, {"tools": TOOLS})
        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {}) or {}
            result = handle_tool_call(tool_name, arguments)
            send_response(id_, result)
        elif method == "ping":
            send_response(id_, {})
        elif id_ is not None:
            send_response(id_, error={"code": -32601, "message": f"Method not found: {method}"})


if __name__ == "__main__":
    main()
