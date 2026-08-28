#!/usr/bin/env python3
"""Subprocess half of RunToolScript (PTC, the hermes code_execution lift): executes ONE
model-written Python script whose tool calls ride JSON lines back to the sidecar, so
intermediate tool results never enter the model's context window; only what the script
prints returns.

Protocol, all newline-delimited JSON over the real stdin/stdout:
  parent -> child   {"script": "<python source>"}
  child  -> parent  {"call": {"name": str, "args": {}}, "seq": int}
  parent -> child   {"seq": int, "text": str, "is_error": bool}
  child  -> parent  {"calls": [{"name": str, "args": {}}, ...], "seq": int}
  parent -> child   {"seq": int, "results": [{"text": str, "is_error": bool}, ...]}
  child  -> parent  {"done": true, "stdout": str, "calls": int, "error": str|null}

A batch is ONE message and the child stays strictly request/response: the parent owns the fan-out,
so it also owns the width cap and the call budget, and results come back in call order by
construction. Threading the child instead would need a reply demultiplexer inside model-written
scope, for the same wall-clock and a race surface we would have to defend forever.

The script's own print() goes to an in-memory buffer (the real stdout is the RPC channel),
capped so a runaway loop can't balloon the process. Runs with a scrubbed env and no auth
token: every tool call is brokered by the parent sidecar, which owns the allowlist."""

import io
import json
import sys

P_STDOUT_CAP_BYTES = 5_000_000

p_rpc_out = sys.stdout
p_rpc_in = sys.stdin
p_seq = 0
p_calls = 0


class PtcToolError(Exception):
    pass


class ToolResult:
    """One call's outcome inside a batch. A failure is DATA here, not an exception, because one bad
    URL in twenty must not throw away the other nineteen."""

    def __init__(self, name, text, error):
        self.name = name
        self.text = text
        self.error = error
        self.ok = error is None

    def __repr__(self):
        return f"ToolResult(name={self.name!r}, ok={self.ok}, error={self.error!r})"


def p_send(obj):
    p_rpc_out.write(json.dumps(obj) + "\n")
    p_rpc_out.flush()


def p_recv():
    line = p_rpc_in.readline()
    if not line:
        raise PtcToolError("sidecar closed the pipe")
    return json.loads(line)


def call_tool(name, args=None):
    """The one function scripts get: run a builtin tool, return its text result.

    Raises PtcToolError when the tool itself errored, so a script can try/except
    around a flaky fetch instead of parsing error prose."""
    global p_seq, p_calls
    if not isinstance(name, str) or not name:
        raise PtcToolError("call_tool needs a tool name string")
    p_seq += 1
    p_calls += 1
    p_send({"call": {"name": name, "args": dict(args or {})}, "seq": p_seq})
    reply = p_recv()
    if reply.get("is_error"):
        raise PtcToolError(str(reply.get("text", "tool failed")))
    return str(reply.get("text", ""))


MAX_BATCH = 25


def call_tools(calls):
    """Run independent tool calls CONCURRENTLY and return their results in the SAME ORDER.

    Each call is {"name": str, "args": dict}. Returns a list of ToolResult (.ok, .text, .error).
    Use this when the calls do not depend on each other; keep call_tool for a chain."""
    global p_seq, p_calls
    if not isinstance(calls, (list, tuple)):
        raise PtcToolError("call_tools needs a list of {'name': ..., 'args': {...}} calls")
    p_batch = []
    for c in calls:
        if not isinstance(c, dict) or not isinstance(c.get("name"), str) or not c.get("name"):
            raise PtcToolError("each call needs a non-empty 'name' and an optional 'args' dict")
        p_batch.append({"name": c["name"], "args": dict(c.get("args") or {})})
    if not p_batch:
        return []
    if len(p_batch) > MAX_BATCH:
        raise PtcToolError(f"call_tools takes at most {MAX_BATCH} calls at once; send them in chunks")
    p_seq += 1
    p_calls += len(p_batch)
    p_send({"calls": p_batch, "seq": p_seq})
    reply = p_recv()
    p_results = reply.get("results")
    if not isinstance(p_results, list) or len(p_results) != len(p_batch):
        raise PtcToolError("sidecar returned a malformed batch reply")
    return [
        ToolResult(
            p_batch[i]["name"],
            "" if r.get("is_error") else str(r.get("text", "")),
            str(r.get("text", "tool failed")) if r.get("is_error") else None,
        )
        for i, r in enumerate(p_results)
    ]


class P_CappedBuffer(io.StringIO):
    def write(self, s):
        if self.tell() < P_STDOUT_CAP_BYTES:
            return super().write(s)
        return len(s)


def main():
    first = p_recv()
    script = str(first.get("script", ""))
    buf = P_CappedBuffer()
    sys.stdout = buf
    error = None
    scope = {
        "call_tool": call_tool,
        "call_tools": call_tools,
        "ToolResult": ToolResult,
        "PtcToolError": PtcToolError,
        "__name__": "__ptc_script__",
    }
    try:
        exec(compile(script, "<tool_script>", "exec"), scope)
    except BaseException as e:
        error = f"{type(e).__name__}: {e}"
    finally:
        sys.stdout = p_rpc_out
    p_send({"done": True, "stdout": buf.getvalue(), "calls": p_calls, "error": error})


if __name__ == "__main__":
    main()
