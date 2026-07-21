import sys
import json
import inspect

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

import asyncio
from backend.apps.spotify_mcp_shim import handlers

async def execute_tool_function(func, args: dict):
    if inspect.iscoroutinefunction(func):
        return await func(**args)
    return func(**args)

async def handle_tool_call(name: str, args: dict) -> dict:
    handler = getattr(handlers, name, None)
    if not handler or not callable(handler):
        return p_err(f"Unknown tool: {name}")
        
    return p_ok(await execute_tool_function(handler, args))

async def process_line(line: str):
    line = line.strip()
    if not line:
        return
        
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        return

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
            res = await handle_tool_call(name, args)
            p_send(id_, res)
        except Exception as e:
            p_send(id_, p_err(f"shim crashed: {e!r}"))
    elif method == "ping":
        p_send(id_, {})
    elif id_ is not None:
        p_send(id_, error={"code": -32601, "message": f"Method not found: {method}"})

async def async_main():
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        await process_line(line)

def main():
    try:
        asyncio.run(async_main())
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()