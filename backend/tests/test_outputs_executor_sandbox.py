"""Regression tests for the Output backend-code sandbox (issue #134).

The AST allowlist and builtins-scrub sandbox was bypassable via
`sys.modules["os"]` (a bare-dict lookup the import allowlist never sees) and
the classic `().__class__.__base__.__subclasses__()` / `__globals__` object
walk. Separately, `/api/outputs/execute` ran vetted (empty-warning) code in the
privileged force-mode env, making `os.system` reachable with no consent.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_outputs_executor_sandbox.py -v
"""

from __future__ import annotations

import asyncio
import os
import tempfile

import pytest

from backend.apps.outputs.executor import (
    execute_backend_code,
    get_code_warnings,
    UnsafeCodeError,
)


def p_run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# --- the #134 escape payloads must all be flagged ----------------------------

@pytest.mark.parametrize("code", [
    "os_mod = sys.modules['os']\nresult = {}",
    "result = {'x': ().__class__.__base__.__subclasses__()}",
    "f = (lambda: 0)\nresult = {'g': f.__globals__}",
    "result = {'c': getattr((), '__class__')}",
    "result = {'m': __import__('os')}",
    "result = {'m': sys.modules}",
    "b = __builtins__\nresult = {}",
])
def test_escape_payloads_are_rejected(code):
    assert get_code_warnings(code), f"expected a warning for: {code!r}"
    # The strict path (default) runs p_validate_code_safety and must refuse.
    with pytest.raises(UnsafeCodeError):
        p_run(execute_backend_code(code, {}))


# --- legitimate data-shaping must stay inside the allowlist (no warnings) -----

@pytest.mark.parametrize("code", [
    'import math, json\nresult = {"a": math.floor(1.9), "b": json.dumps([1, 2])}',
    'import datetime\nresult = {"t": datetime.date(2026, 7, 20).isoformat()}',
    'result = {"u": "a,b,c".split(","), "n": len([1, 2, 3])}',
])
def test_legit_data_shaping_stays_clean(code):
    assert get_code_warnings(code) == []


# --- end-to-end: the escape no longer reads/writes/execs ----------------------

def test_strict_mode_rejects_before_execution():
    code = "os_mod = sys.modules['os']\nresult = {'h': os_mod.path.expanduser('~')}"
    with pytest.raises(UnsafeCodeError):
        p_run(execute_backend_code(code, {}))


def test_minimal_env_blocks_os_system_even_if_ast_bypassed():
    """Mirrors the `/execute` path: skip_validation=True but force_env=False.
    Even reaching os via the bypass, `os.system` finds no shell (PATH/COMSPEC
    stripped by the minimal env), so no command runs."""
    marker = os.path.join(tempfile.gettempdir(), "openswarm_sandbox_test_marker.txt")
    if os.path.exists(marker):
        os.remove(marker)
    code = (
        "os_mod = sys.modules['os']\n"
        f"result = {{'rc': os_mod.system('echo x > {marker.replace(os.sep, '/')}')}}"
    )
    p_run(execute_backend_code(code, {}, skip_validation=True, force_env=False))
    assert not os.path.exists(marker), "os.system reached a shell under the minimal env"


def test_allowlisted_code_runs_and_returns_result():
    code = 'import math\nresult = {"floored": math.floor(input_data["x"])}'
    out = p_run(execute_backend_code(code, {"x": 3.7}))
    assert out.result == {"floored": 3}
