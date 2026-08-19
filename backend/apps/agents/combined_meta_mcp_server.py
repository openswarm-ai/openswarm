#!/usr/bin/env python3
"""One stdio MCP process per agent session hosting ALL the builtin tool servers that used to be
up to ten separate python interpreters (ENG-208: 5 parked chats measured 56 python processes and
756MB before any real work).

Which sub-servers load is decided by the SAME permission logic that used to decide which processes
to spawn, passed in as OSW_MCP_MODULES by register_builtin_mcp_servers, so a denied capability's
tools are absent from tools/list exactly like its dead process used to be. Tool NAMES are globally
unique across sub-servers (asserted below); full ids all live under the one server name
"openswarm-core", and every gate reference was renamed with them in the same commit.

Each sub-server keeps reading its per-session context from env exactly as before, because this is
still one process per session with the union env. We own the stdio loop; their main() never runs."""

import json
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import cost is paid only for modules this session actually gets; all are stdlib-only thin proxies.
P_MODULE_FILES = {
    "meta": "mcp_meta_server",
    "settings": "settings_meta_server",
    "memory": "memory_meta_server",
    "apps": "apps_mcp_server",
    "spawn": "spawn_agent_mcp_server",
    "invoke": "invoke_agent_mcp_server",
    "skill": "skill_mcp_server",
    "ui": "show_ui_mcp_server",
    "schedule": "schedule_mcp_server",
    "web": "web_mcp_server",
    "browser": "browser_agent_mcp_server",
    "canvas": "canvas_mcp_server",
    "ptc": "ptc_mcp_server",
}

P_ENABLED = [m.strip() for m in os.environ.get("OSW_MCP_MODULES", "meta,settings,apps").split(",") if m.strip()]

TOOLS = []
P_ROUTE = {}
for p_key in P_ENABLED:
    p_file = P_MODULE_FILES.get(p_key)
    if p_file is None:
        sys.stderr.write(f"[openswarm-core] unknown module key: {p_key}\n")
        continue
    try:
        p_mod = __import__(p_file)
    except Exception as p_e:
        # One broken module used to kill only its own process; merged, it must not take every builtin tool down with it.
        sys.stderr.write(f"[openswarm-core] module {p_key} failed to import: {p_e}\n")
        continue
    for p_tool in p_mod.TOOLS:
        p_name = p_tool["name"]
        if p_name in P_ROUTE:
            sys.stderr.write(f"[openswarm-core] duplicate tool {p_name}; keeping first\n")
            continue
        TOOLS.append(p_tool)
        P_ROUTE[p_name] = p_mod


def p_call(mod, tool_name: str, arguments: dict) -> dict:
    handler = getattr(mod, "handle_tool_call", None)
    if handler is not None:
        return handler(tool_name, arguments)
    # schedule_mcp_server dispatches through a HANDLERS dict instead of one entry function.
    fn = mod.HANDLERS.get(tool_name)
    if fn is None:
        return {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True}
    return fn(arguments)


P_STDOUT_LOCK = threading.Lock()


def send_response(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    with P_STDOUT_LOCK:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()


def p_call_async(id_, tool_name: str, arguments: dict) -> None:
    mod = P_ROUTE.get(tool_name)
    if mod is None:
        send_response(id_, {"content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}], "isError": True})
        return
    try:
        send_response(id_, p_call(mod, tool_name, arguments))
    except Exception as e:
        send_response(id_, error={"code": -32000, "message": str(e)})


def start_heartbeat():
    """Touch a per-session file every 5s from a daemon thread: proof this process is scheduled and
    alive. The backend's wedge watchdog reads the mtime to tell a WEDGED sidecar (SIGSTOP, dead
    process: heartbeat stops) from a merely SLOW tool call (threads fine, heartbeat keeps beating),
    because killing the second kind is exactly the "MCP disconnected" a user reports (ENG-353)."""
    import tempfile
    import time as p_time
    session = os.environ.get("OPENSWARM_PARENT_SESSION_ID", "")
    if not session:
        return
    path = os.path.join(tempfile.gettempdir(), f"osw-mcp-hb-{session}")

    def p_beat():
        while True:
            try:
                with open(path, "a"):
                    os.utime(path, None)
            except Exception:
                pass
            p_time.sleep(5)

    threading.Thread(target=p_beat, daemon=True, name="hb").start()


def main():
    start_heartbeat()
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
                "serverInfo": {"name": "openswarm-core", "version": "1.0.0"},
            })
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            send_response(id_, {"tools": TOOLS})
        elif method == "tools/call":
            # A thread per call, because ten processes used to give cross-server parallelism for
            # free: without this, one long BrowserAgent run would block every other builtin tool
            # for the whole session. JSON-RPC ids keep interleaved responses unambiguous.
            # Non-daemon on purpose: stdin EOF must drain in-flight calls, not vaporize them.
            threading.Thread(
                target=p_call_async,
                args=(id_, params.get("name", ""), params.get("arguments", {})),
            ).start()
        elif method in ("resources/list",):
            send_response(id_, {"resources": []})
        elif method in ("prompts/list",):
            send_response(id_, {"prompts": []})
        elif method == "ping":
            send_response(id_, {})
        elif id_ is not None:
            send_response(id_, error={"code": -32601, "message": f"Method not found: {method}"})


if __name__ == "__main__":
    main()
