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

# How many of a batch's calls may be in flight at once. The sidecar already runs a thread per MCP
# call, so this is not new concurrency; the cap is here so a 25-call fan-out cannot crowd out the
# chat's other builtin tools while it runs. Module-global, so two scripts in one sidecar share it
# rather than each helping themselves to a full width.
SCRIPT_FANOUT_WIDTH = 8
P_FANOUT_SLOTS = threading.Semaphore(SCRIPT_FANOUT_WIDTH)

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
            "fetch the top hits, sweep memory). Valid tool names: "
            + ", ".join(SCRIPT_ALLOWED_TOOLS) + ". Two functions:\n"
            "call_tools(calls) -> list of results IN THE SAME ORDER, run concurrently. Use this "
            "whenever the calls do not depend on each other, which is most sweeps. Each call is "
            "{'name': ..., 'args': {...}}; each result has .ok, .text and .error, and one failure "
            "never kills the batch. Example: "
            "for r in call_tools([{'name': 'WebFetch', 'args': {'url': u}} for u in urls]): "
            "print(r.text if r.ok else 'skipped ' + r.error)\n"
            "call_tool(name, args_dict) -> str, one call, for a CHAIN where each call needs the "
            "previous result. A failed tool raises PtcToolError (catchable).\n"
            "Print ONLY your distilled findings. Budget: "
            f"{MAX_TOOL_CALLS} tool calls, {SCRIPT_TIMEOUT_S:.0f}s, printed output capped at 50KB."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "script": {
                    "type": "string",
                    "description": "Python source. Example: hits = call_tool('WebSearch', {'query': 'x'}) (a chain step), then call_tools([{'name': 'WebFetch', 'args': {'url': u}} for u in urls]) to fetch them all at once, and print the aggregate.",
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


def p_dispatch_batch(calls: list, deadline: float) -> list:
    """Fan a batch out and gather in CALL ORDER. One call's failure is that call's result, never the
    batch's, which is the whole reason a script would use this instead of a loop."""
    p_out: list = [None] * len(calls)

    def p_one(i: int, call: dict) -> None:
        with P_FANOUT_SLOTS:
            p_out[i] = p_dispatch(str(call.get("name", "")), dict(call.get("args") or {}))

    p_threads = [threading.Thread(target=p_one, args=(i, c), daemon=True) for i, c in enumerate(calls)]
    for t in p_threads:
        t.start()
    for t in p_threads:
        # The script budget is the only ceiling; joining past it would let a batch outlive the
        # deadline the reaper is already enforcing on the child.
        t.join(timeout=max(0.0, deadline - time.monotonic()))
    return [
        r if r is not None else {"text": "call did not finish inside the script budget", "is_error": True}
        for r in p_out
    ]


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
            batch = msg.get("calls")
            if isinstance(batch, list):
                p_budget = f"tool call budget ({MAX_TOOL_CALLS}) exhausted; print what you have"
                # Per item, not per batch: the calls that fit still run, and the rest say why not.
                p_room = max(0, MAX_TOOL_CALLS - calls_used)
                p_run, p_over = batch[:p_room], batch[p_room:]
                calls_used += len(batch)
                p_results = p_dispatch_batch(p_run, deadline) if p_run else []
                p_results += [{"text": p_budget, "is_error": True} for _ in p_over]
                proc.stdin.write(json.dumps({"seq": msg.get("seq"), "results": p_results}) + "\n")
                proc.stdin.flush()
                continue
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
