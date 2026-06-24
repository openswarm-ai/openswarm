#!/usr/bin/env python3
"""Stdio MCP server letting an agent read and edit its own OpenSwarm Settings.

Two tools, SettingsRead and SettingsWrite, backed by /api/settings-meta. Always
on, no activation gate (Settings is the agent's own house). The backend enforces
the only hard rule: it can change anything EXCEPT disconnect the credential
powering its own run ("no suicide"), and reads come back with secrets redacted
to configured/not, never the value. Both guards live server-side so this thin
client can't weaken them."""

import json
import os
import sys
import urllib.error
import urllib.request

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/settings-meta"
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")


TOOLS = [
    {
        "name": "SettingsRead",
        "description": (
            "Read the user's OpenSwarm Settings (model defaults, theme, prompts, "
            "connected providers, toggles). Secrets come back as configured/not, "
            "never the actual key. Call this before SettingsWrite so you change "
            "the right field to the right value."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "SettingsWrite",
        "description": (
            "Change one or more OpenSwarm Settings. Pass `changes` as a map of "
            "setting field name to new value (use the exact field names from "
            "SettingsRead, e.g. {\"theme\": \"light\", \"default_model\": \"opus-4-8\"}). "
            "You can set or clear API keys too. Two things you cannot do: clear the "
            "credential currently powering YOU (it's refused so you don't cut your "
            "own run off), and touch subscription/connection state (managed by the "
            "Subscription section; tell the user to use it). The result reports each "
            "field as applied / refused / unknown, so relay what actually changed."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "changes": {
                    "type": "object",
                    "description": "Field name -> new value. e.g. {\"theme\": \"light\"}.",
                    "additionalProperties": True,
                },
            },
            "required": ["changes"],
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
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {detail}"}
    except Exception as e:
        return {"error": str(e)}


def p_format_read(settings: dict) -> str:
    """Render redacted settings compactly so the model spends tokens on the
    values it can act on, not on JSON punctuation."""
    lines = ["Current OpenSwarm Settings (secrets shown as configured/not):"]
    for key in sorted(settings.keys()):
        val = settings[key]
        if isinstance(val, dict) and "configured" in val:
            state = f"configured (…{val['last4']})" if val.get("configured") else "not configured"
            lines.append(f"- {key}: {state}")
        else:
            lines.append(f"- {key}: {json.dumps(val)}")
    return "\n".join(lines)


def p_format_write(outcomes: dict) -> str:
    applied = [f for f, o in outcomes.items() if o.get("status") == "applied"]
    parts = []
    if applied:
        parts.append("Applied: " + ", ".join(sorted(applied)))
    for field, o in outcomes.items():
        status = o.get("status")
        if status in ("applied", None):
            continue
        # "error" is transient (retryable); "refused"/"unknown" are not.
        verb = "Failed" if status == "error" else "Refused"
        parts.append(f"{verb} {field}: {o.get('reason', status)}")
    if not parts:
        return "No changes were applied."
    return "\n".join(parts)


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name == "SettingsRead":
        result = call_backend("read", {})
        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
        return {"content": [{"type": "text", "text": p_format_read(result.get("settings", {}))}]}

    if tool_name == "SettingsWrite":
        changes = arguments.get("changes")
        if not isinstance(changes, dict) or not changes:
            return {"content": [{"type": "text", "text": "Error: `changes` must be a non-empty object of field -> value."}], "isError": True}
        result = call_backend("write", {"changes": changes})
        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
        return {"content": [{"type": "text", "text": p_format_write(result.get("outcomes", {}))}]}

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
                "serverInfo": {"name": "openswarm-settings-meta", "version": "1.0.0"},
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
