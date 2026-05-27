import ast
import asyncio
import json
import logging
import os
import sys
import tempfile
from dataclasses import dataclass

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 30

# Modules backend code is allowed to import. Trade-off: a determined attacker
# can find ways around this (e.g. string-encoded imports via tricks the AST
# validator can't see), but the allowlist kills the easy paths cheaply and
# pairs with cwd=tempdir + minimal env so the blast radius is small even if
# a payload slips past. Keep this list to "data shaping" libraries; no I/O,
# no networking, no subprocess.
_ALLOWED_MODULES = frozenset({
    "json", "math", "re", "datetime", "collections", "itertools",
    "functools", "statistics", "decimal", "fractions", "random",
    "string", "textwrap", "unicodedata", "csv", "copy", "enum",
    "dataclasses", "typing", "abc", "numbers", "uuid", "hashlib",
    "base64", "binascii", "operator", "heapq", "bisect", "array",
})

# Builtin functions that punch holes through the allowlist or do I/O. Direct
# calls (e.g. `eval(...)`) are caught here. Attribute-style calls
# (`__builtins__.eval(...)`) are blocked by the preamble's `delattr` loop in
# the subprocess.
_BLOCKED_BUILTINS = frozenset({
    "exec", "eval", "compile", "__import__", "open", "input",
    "breakpoint", "exit", "quit",
})


class UnsafeCodeError(Exception):
    """Raised when AST validation rejects user-supplied backend code."""


def get_code_warnings(code: str) -> list[str]:
    """Return human-readable warnings for AST-visible risks, without raising.

    Used by `/api/outputs/execute` to surface risks to the user in the run
    dialog before executing; so a legit Output that needs `pandas` doesn't
    silently 500 with "import not allowed," it gets a "this Output uses
    unsafe imports; review and click Run Anyway" affordance.

    Returns [] for code that's fully inside the allowlist. A syntax error
    is reported as a single warning rather than raised so the dialog can
    show it next to the code.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"Syntax error: {e}"]

    warnings: list[str] = []
    seen: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in _ALLOWED_MODULES:
                    msg = f"Imports '{alias.name}' (outside the safe-data-shaping allowlist)"
                    if msg not in seen:
                        seen.add(msg)
                        warnings.append(msg)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                root = node.module.split(".")[0]
                if root not in _ALLOWED_MODULES:
                    msg = f"Imports from '{node.module}' (outside the safe-data-shaping allowlist)"
                    if msg not in seen:
                        seen.add(msg)
                        warnings.append(msg)
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in _BLOCKED_BUILTINS:
                msg = f"Calls builtin '{node.func.id}()' which can escape the sandbox"
                if msg not in seen:
                    seen.add(msg)
                    warnings.append(msg)
    return warnings


def _validate_code_safety(code: str) -> None:
    """Raise UnsafeCodeError on the first AST-visible risk. Thin wrapper
    around get_code_warnings for callers that want the strict-reject
    behavior (the default `execute_backend_code` path). Callers that want
    to show warnings to a user and let them override should call
    get_code_warnings directly and pass `skip_validation=True` to
    execute_backend_code."""
    warnings = get_code_warnings(code)
    if warnings:
        raise UnsafeCodeError(warnings[0])


# Env vars we always scrub from the subprocess, regardless of strict-vs-force.
# These are the keys an attacker would actually want; install token, provider
# API keys, cloud credentials. Everything else is local-machine convenience.
_SCRUBBED_ENV_KEYS = frozenset({
    "OPENSWARM_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "STRIPE_API_KEY",
    "STRIPE_SECRET_KEY",
    "GITHUB_TOKEN",
})


def _minimal_env(force: bool = False) -> dict:
    """Build the env for the executor subprocess.

    Strict mode (force=False): only language essentials. AST-validated code
    is data-shaping only; `import os` and `open()` are blocked, so the
    subprocess can't read env vars or expand `~` anyway. Minimal env is
    correct here.

    Force mode (force=True): user has explicitly approved unsafe imports
    via the HITL preview. They expect the code to behave like a normal
    Python process; read HOME, find files, etc. Inherit the real env
    minus credentials, so an `open(os.path.expanduser("~/data.csv"))`
    actually works instead of silently misbehaving.

    Both modes scrub _SCRUBBED_ENV_KEYS so even force-mode code never
    sees the install token or provider API keys.
    """
    if force:
        env = {k: v for k, v in os.environ.items() if k not in _SCRUBBED_ENV_KEYS}
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        # Force UTF-8 even if the parent somehow lacked it (dev mode where
        # Electron didn't inject PYTHONUTF8). Without this, a child reading
        # non-ASCII stdin/files on a cp1252 Windows machine raises
        # UnicodeDecodeError, the "works on my laptop, not theirs" failure.
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        return env

    env = {
        "PYTHONDONTWRITEBYTECODE": "1",
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
        # LANG/LC_ALL are POSIX-only; on Windows the active code page (cp1252)
        # decides default encoding instead. PYTHONUTF8 + PYTHONIOENCODING force
        # UTF-8 for this from-scratch env so json.loads(sys.stdin.read()) of
        # non-ASCII input_data doesn't blow up on stock Windows machines.
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    if sys.platform == "win32":
        for k in ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE"):
            if k in os.environ:
                env[k] = os.environ[k]
    return env


@dataclass
class BackendExecResult:
    result: dict
    stdout: str
    stderr: str


async def execute_backend_code(
    code: str, input_data: dict, *, skip_validation: bool = False
) -> BackendExecResult:
    """Execute user-provided Python code in a subprocess.

    The code receives ``input_data`` as a global dict and must assign its
    result to a global ``result`` dict.  User print() calls are captured
    separately from the result via an in-process StringIO redirect.

    Security boundaries (defense in depth; none alone is sufficient):
      1. AST allowlist on imports + blocked-builtin call list.
      2. Subprocess cwd = fresh temp dir (not the OpenSwarm process cwd).
      3. Subprocess env strips PATH, all *_TOKEN / *_API_KEY inheritance.
      4. Preamble scrubs dangerous attrs off `builtins` inside the subprocess
         to catch AST-bypass tricks (e.g. metaclass shenanigans).
      5. 30s wall-clock timeout, killed on overrun.

    `skip_validation=True` bypasses #1; intended ONLY for callers that
    have already surfaced the warnings to a user and gotten explicit
    consent (the `/api/outputs/execute` HITL flow). #2, #5 always run.
    """

    if not skip_validation:
        _validate_code_safety(code)

    preamble = (
        "import json, sys, io, builtins\n"
        # Defense-in-depth: scrub dangerous attrs off `builtins` so
        # attribute-style accesses (metaclass.__subclasses__ chains) can't
        # reach them. NOTE: __import__ is deliberately NOT scrubbed , 
        # Python's `import` statement bytecode reads `__import__` from
        # builtins, so removing it makes EVERY import (including allowlisted
        # ones like `import math`) fail with "ImportError: __import__ not
        # found". The AST allowlist on the host is what blocks `import
        # subprocess`; the per-subprocess scrub just plugs the named-builtin
        # attack vectors that the AST can't see (eval/exec via attribute
        # access on objects, etc.).
        "for _b in ('exec','eval','compile','open','input',\n"
        "           'breakpoint','exit','quit'):\n"
        "    try: delattr(builtins, _b)\n"
        "    except AttributeError: pass\n"
        "_orig_stdout = sys.stdout\n"
        "_capture = io.StringIO()\n"
        "sys.stdout = _capture\n"
        "input_data = json.loads(sys.stdin.read())\n"
        "result = {}\n"
    )
    postamble = (
        "\nsys.stdout = _orig_stdout\n"
        'json.dump({"__stdout__": _capture.getvalue(), "__result__": result}, sys.stdout)\n'
    )
    wrapper = preamble + code + postamble

    with tempfile.TemporaryDirectory(prefix="openswarm-exec-") as workdir:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", wrapper,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=workdir,
            env=_minimal_env(force=skip_validation),
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=json.dumps(input_data).encode()),
                timeout=TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"Backend code execution timed out after {TIMEOUT_SECONDS}s")

    stderr_text = stderr.decode(errors="replace").strip()

    if proc.returncode != 0:
        raise RuntimeError(f"Backend code error (exit {proc.returncode}): {stderr_text}")

    try:
        parsed = json.loads(stdout.decode())
        return BackendExecResult(
            result=parsed.get("__result__", {}),
            stdout=parsed.get("__stdout__", ""),
            stderr=stderr_text,
        )
    except json.JSONDecodeError:
        raw = stdout.decode(errors="replace").strip()
        raise RuntimeError(
            f"Backend code did not produce valid JSON. Raw output: {raw[:500]}"
        )
