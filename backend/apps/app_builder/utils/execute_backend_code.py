import asyncio
import json
import sys
from typing import Dict, Any
from pydantic import BaseModel
from typeguard import typechecked

TIMEOUT_SECONDS = 30

class BackendExecResult(BaseModel):
    result: Dict[str, Any]
    stdout: str
    stderr: str

@typechecked
async def execute_backend_code(code: str) -> BackendExecResult:
    """Execute user-provided Python code in a subprocess.

    The code must assign its result to a global ``result`` dict.
    User print() calls are captured separately from the result via
    an in-process StringIO redirect.
    """

    preamble: str = (
        "import json, sys, io\n"
        "_orig_stdout = sys.stdout\n"
        "_capture = io.StringIO()\n"
        "sys.stdout = _capture\n"
        "result = {}\n"
    )
    postamble: str = (
        "\nsys.stdout = _orig_stdout\n"
        'json.dump({"__stdout__": _capture.getvalue(), "__result__": result}, sys.stdout)\n'
    )
    wrapper: str = preamble + code + postamble

    proc: asyncio.subprocess.Process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", wrapper,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout: bytes
        stderr: bytes
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"Backend code execution timed out after {TIMEOUT_SECONDS}s")

    stderr_text: str = stderr.decode(errors="replace").strip()

    if proc.returncode != 0:
        raise RuntimeError(f"Backend code error (exit {proc.returncode}): {stderr_text}")

    try:
        parsed: Dict[str, Any] = json.loads(stdout.decode())
        return BackendExecResult(
            result=parsed.get("__result__", {}),
            stdout=parsed.get("__stdout__", ""),
            stderr=stderr_text,
        )
    except json.JSONDecodeError:
        raw: str = stdout.decode(errors="replace").strip()
        raise RuntimeError(
            f"Backend code did not produce valid JSON. Raw output: {raw[:500]}"
        )
