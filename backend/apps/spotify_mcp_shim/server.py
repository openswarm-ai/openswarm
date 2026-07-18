import sys
import json

from backend.apps.spotify_mcp_shim.tools import TOOLS

def p_send(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def p_err(text: str) -> dict:
    return {"content": [{"type": "text", "text": f"Error: {text}"}], "isError": True}

def p_ok(payload) -> dict:
    if isinstance(payload, str):
        return {"content": [{"type": "text", "text": payload}]}
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2, default=str)}]}

from backend.apps.spotify_mcp_shim.handlers import play_track

def handle_tool_call(name: str, args: dict) -> dict:
    match name:
        case "play_track":
            return p_ok(play_track(**args))

    return p_err(f"Unknown tool: {name}")

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
            p_send(id_, {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "openswarm-spotify", "version": "1.0.0"},
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            p_send(id_, {"tools": TOOLS})
        elif method == "tools/call":
            name = params.get("name", "")
            args = params.get("arguments", {}) or {}
            try:
                p_send(id_, handle_tool_call(name, args))
            except Exception as e:
                p_send(id_, p_err(f"shim crashed: {e!r}"))
        elif method == "ping":
            p_send(id_, {})
        elif id_ is not None:
            p_send(id_, error={"code": -32601, "message": f"Method not found: {method}"})

if __name__ == "__main__":
    main()