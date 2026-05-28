#!/usr/bin/env python3
"""Stdio MCP server exposing the MCP activation gate (MCPList/MCPSearch/MCPActivate)."""

import json
import os
import sys
import urllib.error
import urllib.request

BACKEND_PORT = os.environ.get("OPENSWARM_PORT", "8324")
BACKEND_AUTH = os.environ.get("OPENSWARM_AUTH_TOKEN", "")
BACKEND_URL = f"http://127.0.0.1:{BACKEND_PORT}/api/mcp-meta"
PARENT_SESSION_ID = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")


TOOLS = [
    {
        "name": "MCPList",
        "description": (
            "List installed MCP servers (name, one-sentence purpose, "
            "active/available status). Cheap. Use for a broad survey before "
            "picking a server."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "MCPSearch",
        "description": (
            "Rank MCP servers by relevance to a query. Use before MCPActivate "
            "when unsure which server fits. Tools are NOT callable until you "
            "also MCPActivate."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What you need (e.g. 'send email', 'post to slack').",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "MCPActivate",
        "description": (
            "Request activation of an MCP server for this session. Triggers a "
            "user approval prompt; on approve the server's tools become callable "
            "next turn. Always confirm the server name via MCPList/MCPSearch first; "
            "invalid names return alternatives instead of activating."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "server_name": {
                    "type": "string",
                    "description": "Sanitized name from MCPList/MCPSearch (e.g. 'gmail', 'slack').",
                },
                "reason": {
                    "type": "string",
                    "description": "Why you need it; shown to the user in the approval prompt.",
                },
            },
            "required": ["server_name"],
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
        f"{BACKEND_URL}/{action}",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"error": str(e)}


def format_servers(servers: list[dict], heading: str = "") -> str:
    if not servers:
        return ""
    lines = []
    if heading:
        lines.append(heading)
    for s in servers:
        name = s.get("name", "")
        desc = s.get("description") or f"{name} integration"
        status = s.get("status", "available")
        lines.append(f"- `{name}` [{status}]; {desc}")
    return "\n".join(lines)


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name == "MCPList":
        result = call_backend("list", {})
        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
        active = result.get("active", [])
        available = result.get("available", [])
        if not active and not available:
            return {"content": [{"type": "text", "text": "No MCP servers are installed. The user can install one from the Tools page."}]}
        parts = []
        if active:
            parts.append(format_servers(active, "Active (callable now):"))
        if available:
            parts.append(format_servers(available, "Available (call MCPActivate to enable):"))
        return {"content": [{"type": "text", "text": "\n\n".join(parts)}]}

    if tool_name == "MCPSearch":
        query = arguments.get("query", "")
        if not query:
            return {"content": [{"type": "text", "text": "Error: query is required"}], "isError": True}
        result = call_backend("search", {"query": query})
        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
        matches = result.get("matches", [])
        if not matches:
            return {"content": [{"type": "text", "text": f"No MCP servers matched '{query}'. Try MCPList to see everything installed, or tell the user no suitable server is connected."}]}
        body = format_servers(matches, f"Top matches for '{query}':")
        body += "\n\nNext step: pick one and call MCPActivate(server_name) to request activation."
        return {"content": [{"type": "text", "text": body}]}

    if tool_name == "MCPActivate":
        server_name = arguments.get("server_name", "")
        reason = arguments.get("reason", "")
        if not server_name:
            return {"content": [{"type": "text", "text": "Error: server_name is required"}], "isError": True}
        result = call_backend("activate", {"server_name": server_name, "reason": reason})
        if "error" in result:
            return {"content": [{"type": "text", "text": f"Error: {result['error']}"}], "isError": True}
        if result.get("status") == "unknown_server":
            available = result.get("available", [])
            return {
                "content": [{
                    "type": "text",
                    "text": (
                        f"Unknown MCP server '{server_name}'. Valid options: "
                        + ", ".join(f"`{s}`" for s in available)
                        + ". Call MCPList for full descriptions."
                    ),
                }],
                "isError": True,
            }
        if result.get("status") == "already_active":
            return {"content": [{"type": "text", "text": f"`{server_name}` is already active for this session; its tools should be callable now."}]}
        if result.get("status") == "activated":
            return {
                "content": [{
                    "type": "text",
                    "text": (
                        f"Activated `{server_name}`. Its tools (`mcp__{server_name}__*`) "
                        f"are NOT callable in this turn; the transport snapshot is "
                        f"already locked. This turn will end automatically and a "
                        f"hidden continuation turn will fire with the new tools "
                        f"loaded. Do not attempt any other tool call now."
                    ),
                }],
            }
        return {"content": [{"type": "text", "text": f"Unexpected response: {json.dumps(result)}"}], "isError": True}

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
                "serverInfo": {
                    "name": "openswarm-mcp-meta",
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
            try:
                result = handle_tool_call(tool_name, arguments)
                send_response(id_, result)
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
