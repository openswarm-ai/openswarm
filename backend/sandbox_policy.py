"""Shared policy for local Python data-shaping sandboxes."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SandboxPolicy:
    allowed_modules: frozenset[str]
    blocked_builtins: frozenset[str]
    timeout_seconds: int

    @property
    def preamble(self) -> str:
        return (
            "import json, sys, io, builtins\n"
            "p_stdout = sys.stdout\n"
            "p_capture = io.StringIO()\n"
            "sys.stdout = p_capture\n"
            "input_data = json.loads(sys.stdin.read())\n"
            "result = {}\n"
        )

    @property
    def hardening(self) -> str:
        # Warm the allowlist BEFORE scrubbing builtins: half the stdlib borrows the builtins the scrub deletes while it loads (dataclasses and namedtuple call exec at class creation), so import everything allowed first, then take the I/O builtins away and drop the module handles the preamble bound. exec/eval/compile stay: the stdlib needs them at runtime and the static gate forbids direct calls instead.
        return (
            f"for p_name in {tuple(sorted(self.allowed_modules))!r}:\n"
            "    try: __import__(p_name)\n"
            "    except ImportError: pass\n"
            "for p_name in ('open','input','breakpoint','exit','quit'):\n"
            "    try: delattr(builtins, p_name)\n"
            "    except AttributeError: pass\n"
            "del sys, io, builtins, p_name\n"
        )

    @property
    def postamble(self) -> str:
        return (
            "\np_stdout.write(json.dumps({\"__stdout__\": p_capture.getvalue(), \"__result__\": result}))\n"
        )

    def wrap(self, code: str, approved: bool = False) -> str:
        # `approved` is the ONLY thing that drops the runtime hardening: the user saw the warnings and clicked Run Anyway. The edge never passes it, so published apps always run behind the walls.
        return self.preamble + ("" if approved else self.hardening) + code + self.postamble


SANDBOX_POLICY = SandboxPolicy(
    allowed_modules=frozenset({
        "json", "math", "re", "datetime", "collections", "itertools",
        "functools", "statistics", "decimal", "fractions", "random",
        "string", "textwrap", "unicodedata", "csv", "copy", "enum",
        "dataclasses", "typing", "abc", "numbers", "uuid", "hashlib",
        "base64", "binascii", "operator", "heapq", "bisect", "array",
    }),
    blocked_builtins=frozenset({
        "exec", "eval", "compile", "__import__", "open", "input",
        "breakpoint", "exit", "quit",
    }),
    timeout_seconds=30,
)
