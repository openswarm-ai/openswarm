from backend.apps.outputs import code_safety, executor
from backend.sandbox_policy import SANDBOX_POLICY


def test_backend_uses_shared_sandbox_policy():
    # One policy (lists + preamble) for the executor; the AST gate keeps its own copy of the lists because
    # openswarm-edge mirrors code_safety.py verbatim, so the two are asserted equal instead of identical.
    assert executor.TIMEOUT_SECONDS == SANDBOX_POLICY.timeout_seconds
    assert executor.SANDBOX_POLICY is SANDBOX_POLICY
    assert set(code_safety.ALLOWED_MODULES) == set(SANDBOX_POLICY.allowed_modules)
    assert code_safety.get_code_warnings("import math\nresult = {}") == []
    assert code_safety.get_code_warnings("import os\nresult = {}")
    # Unapproved runs carry the runtime hardening; only an explicit user approval (Run Anyway) drops it.
    assert SANDBOX_POLICY.wrap("result = {}") == (
        SANDBOX_POLICY.preamble + SANDBOX_POLICY.hardening + "result = {}" + SANDBOX_POLICY.postamble
    )
    assert SANDBOX_POLICY.wrap("result = {}", approved=True) == (
        SANDBOX_POLICY.preamble + "result = {}" + SANDBOX_POLICY.postamble
    )
