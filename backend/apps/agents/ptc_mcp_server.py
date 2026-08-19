#!/usr/bin/env python3
"""RunToolScript: the model writes a short Python script that chains builtin tools, and only
the script's printed output enters context (PTC, lifted from hermes-agent's code_execution_tool,
MIT). A 10-page research sweep costs the tokens of its summary instead of ten raw page dumps.

Safety shape: the script subprocess gets a minimal env with NO auth token; every tool call is
brokered here against an explicit ALLOWLIST (never the deny-list's guess), so the gated surfaces
(MCP activation, delegation, HITL, canvas, schedules, SettingsWrite) are unreachable from scripts
by construction. Agents already hold always_allow Bash, so this adds reach for no new privilege."""

import json
import os
import subprocess
import sys
import threading
import time

SCRIPT_TIMEOUT_S = 300.0
MAX_TOOL_CALLS = 50
MAX_STDOUT_BYTES = 50_000

# Read/write-safe, ungated tools only. Everything else is invisible to scripts on purpose.
SCRIPT_ALLOWED_TOOLS = ("WebSearch", "WebFetch", "MemoryRead", "MemoryWrite", "SettingsRead", "Skill")

TOOLS = [
    {
        "name": "RunToolScript",
        "description": (
            "Run a short Python script that chains multiple tool calls in ONE turn; only what "
            "the script print()s comes back to you, so bulky intermediate results never enter "
            "your context. Use this whenever a task needs 3+ tool calls whose raw outputs you "
            "would only aggregate anyway (fetch N pages and extract one fact each, search then "
            "fetch the top hits, sweep memory). The script gets one function: "
            "call_tool(name, args_dict) -> str, valid names: "
            + ", ".join(SCRIPT_ALLOWED_TOOLS) + ". A failed tool raises PtcToolError (catchable). "
            "Print ONLY your distilled findings. Budget: "
            f"{MAX_TOOL_CALLS} tool calls, {SCRIPT_TIMEOUT_S:.0f}s, printed output capped at 50KB."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "script": {
                    "type": "string",
                    "description": "Python source. Example: results = call_tool('WebSearch', {'query': 'x'}) then loop call_tool('WebFetch', {'url': u}) and print the aggregate.",
                },
            },
            "required": ["script"],
        },
    },
]


def p_core():
    """The running combined sidecar (spawned as __main__), which owns tool routing. Tests
    inject a stand-in via set_core_for_tests."""
    if p_core_override is not None:
        return p_core_override
    main_mod = sys.modules.get("__main__")
    if main_mod is not None and hasattr(main_mod, "P_ROUTE") and hasattr(main_mod, "p_call"):
        return main_mod
    return None


p_core_override = None


def set_core_for_tests(core) -> None:
    global p_core_override
    p_core_override = core


def p_result_text(result: dict) -> str:
    parts = []
    for c in result.get("content", []) or []:
        if isinstance(c, dict) and c.get("type") == "text":
            parts.append(str(c.get("text", "")))
    return "\n".join(parts)


def p_dispatch(name: str, args: dict) -> dict:
    """One brokered inner call: allowlist first, then the sidecar's own routing."""
    if name not in SCRIPT_ALLOWED_TOOLS:
        return {"text": f"tool '{name}' is not callable from scripts; allowed: {', '.join(SCRIPT_ALLOWED_TOOLS)}", "is_error": True}
    core = p_core()
    if core is None:
        return {"text": "tool routing unavailable", "is_error": True}
    mod = core.P_ROUTE.get(name)
    if mod is None:
        return {"text": f"tool '{name}' is not loaded in this session", "is_error": True}
    try:
        result = core.p_call(mod, name, args)
    except Exception as e:
        return {"text": f"tool '{name}' raised: {e}", "is_error": True}
    return {"text": p_result_text(result), "is_error": bool(result.get("isError"))}


def p_elide(text: str, cap: int = MAX_STDOUT_BYTES) -> str:
    raw = text.encode("utf-8", errors="replace")
    if len(raw) <= cap:
        return text
    head = int(cap * 0.4)
    tail = cap - head
    return (
        raw[:head].decode("utf-8", errors="replace")
        + f"\n\n[... output elided: {len(raw)} bytes total, cap {cap} ...]\n\n"
        + raw[-tail:].decode("utf-8", errors="replace")
    )


def p_runner_env() -> dict:
    # Minimal on purpose: the child needs no secrets because the parent brokers every call.
    keep = ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT", "TEMP", "TMP")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def p_mcp_text(text: str, is_error: bool = False) -> dict:
    out = {"content": [{"type": "text", "text": text}]}
    if is_error:
        out["isError"] = True
    return out


def handle_tool_call(tool_name: str, arguments: dict) -> dict:
    if tool_name != "RunToolScript":
        return p_mcp_text(f"Unknown tool: {tool_name}", is_error=True)
    script = str(arguments.get("script", "")).strip()
    if not script:
        return p_mcp_text("script is required", is_error=True)
    runner = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ptc_script_runner.py")
    try:
        proc = subprocess.Popen(
            [sys.executable, "-u", runner],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=p_runner_env(), text=True,
        )
    except Exception as e:
        return p_mcp_text(f"could not start script runner: {e}", is_error=True)
    deadline = time.monotonic() + SCRIPT_TIMEOUT_S
    # The read loop blocks in readline, so the deadline needs teeth of its own: the timer kills the child, which turns the block into a clean EOF.
    p_reaper = threading.Timer(SCRIPT_TIMEOUT_S, lambda: proc.poll() is None and proc.kill())
    p_reaper.daemon = True
    p_reaper.start()
    calls_used = 0
    try:
        proc.stdin.write(json.dumps({"script": script}) + "\n")
        proc.stdin.flush()
        while True:
            if time.monotonic() > deadline:
                proc.kill()
                return p_mcp_text(
                    f"script exceeded the {SCRIPT_TIMEOUT_S:.0f}s budget after {calls_used} tool calls; nothing was returned. Break the work into smaller scripts.",
                    is_error=True,
                )
            line = proc.stdout.readline()
            if not line:
                if time.monotonic() > deadline:
                    return p_mcp_text(
                        f"script exceeded the {SCRIPT_TIMEOUT_S:.0f}s budget after {calls_used} tool calls; nothing was returned. Break the work into smaller scripts.",
                        is_error=True,
                    )
                return p_mcp_text(f"script runner exited unexpectedly after {calls_used} tool calls", is_error=True)
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("done"):
                out = p_elide(str(msg.get("stdout", "")))
                err = msg.get("error")
                footer = f"\n\n[script ran {int(msg.get('calls', 0))} tool call(s)]"
                if err:
                    return p_mcp_text(f"script raised {err}\n\npartial output:\n{out}{footer}", is_error=True)
                if not out.strip():
                    return p_mcp_text(f"script printed nothing; print your findings next time.{footer}", is_error=True)
                return p_mcp_text(out + footer)
            call = msg.get("call")
            if not isinstance(call, dict):
                continue
            calls_used += 1
            if calls_used > MAX_TOOL_CALLS:
                reply = {"seq": msg.get("seq"), "text": f"tool call budget ({MAX_TOOL_CALLS}) exhausted; print what you have", "is_error": True}
            else:
                reply = {"seq": msg.get("seq"), **p_dispatch(str(call.get("name", "")), dict(call.get("args") or {}))}
            proc.stdin.write(json.dumps(reply) + "\n")
            proc.stdin.flush()
    except BrokenPipeError:
        return p_mcp_text(f"script runner pipe broke after {calls_used} tool calls", is_error=True)
    finally:
        p_reaper.cancel()
        try:
            if proc.poll() is None:
                proc.kill()
        except Exception:
            pass
