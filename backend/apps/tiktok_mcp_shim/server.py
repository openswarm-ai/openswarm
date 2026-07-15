"""Stdio JSON-RPC MCP server for TikTok.

Mirrors the discord/reddit/x shim loop: stdlib-only, no backend.config imports, so the
subprocess starts fast. The tool surface lives in tools.py; dispatch in handlers.py.
"""

import json
import sys
from typing import Any, Optional

from backend.apps.tiktok_mcp_shim.handlers import handle_tool_call, mcp_err
from backend.apps.tiktok_mcp_shim.tools import TOOLS


def p_send(id_: Any, result: Optional[dict] = None, error: Optional[dict] = None) -> None:
    msg: dict = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main() -> None:
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
                "serverInfo": {"name": "openswarm-tiktok", "version": "1.0.0"},
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
                p_send(id_, mcp_err(f"shim crashed: {e!r}"))
        elif method == "ping":
            p_send(id_, {})
        elif id_ is not None:
            p_send(id_, error={"code": -32601, "message": f"Method not found: {method}"})


if __name__ == "__main__":
    main()
