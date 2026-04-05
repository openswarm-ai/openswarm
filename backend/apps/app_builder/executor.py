import asyncio
import json
import logging
import sys
from dataclasses import dataclass

logger = logging.getLogger(__name__)

TIMEOUT_SECONDS = 30


@dataclass
class BackendExecResult:
    result: dict
    stdout: str
    stderr: str


async def execute_backend_code(code: str) -> BackendExecResult:
    """Execute user-provided Python code in a subprocess.

    The code must assign its result to a global ``result`` dict.
    User print() calls are captured separately from the result via
    an in-process StringIO redirect.
    """

    preamble = (
        "import json, sys, io\n"
        "_orig_stdout = sys.stdout\n"
        "_capture = io.StringIO()\n"
        "sys.stdout = _capture\n"
        "result = {}\n"
    )
    postamble = (
        "\nsys.stdout = _orig_stdout\n"
        'json.dump({"__stdout__": _capture.getvalue(), "__result__": result}, sys.stdout)\n'
    )
    wrapper = preamble + code + postamble

    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-c", wrapper,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
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
