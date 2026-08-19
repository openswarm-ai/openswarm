#!/usr/bin/env python3
"""Subprocess half of RunToolScript (PTC, the hermes code_execution lift): executes ONE
model-written Python script whose tool calls ride JSON lines back to the sidecar, so
intermediate tool results never enter the model's context window; only what the script
prints returns.

Protocol, all newline-delimited JSON over the real stdin/stdout:
  parent -> child   {"script": "<python source>"}
  child  -> parent  {"call": {"name": str, "args": {}}, "seq": int}
  parent -> child   {"seq": int, "text": str, "is_error": bool}
  child  -> parent  {"done": true, "stdout": str, "calls": int, "error": str|null}

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
    scope = {"call_tool": call_tool, "PtcToolError": PtcToolError, "__name__": "__ptc_script__"}
    try:
        exec(compile(script, "<tool_script>", "exec"), scope)
    except BaseException as e:
        error = f"{type(e).__name__}: {e}"
    finally:
        sys.stdout = p_rpc_out
    p_send({"done": True, "stdout": buf.getvalue(), "calls": p_calls, "error": error})


if __name__ == "__main__":
    main()
