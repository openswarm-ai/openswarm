"""A fault harness is only useful if the fault it fires is the one the guard actually looks for.

Half the safety code only runs on rare failures, so it was never drilled: waiting for a wedged
sidecar or a provider refusal in the wild means the guard is hoped for, not proven (ENG-385's cap
measured 0.0%; ENG-391's breaker never runs on codex). These pin that the injected text is
classified the same way a REAL failure is, and that the harness is inert unless armed.
"""

import re
import pytest

from backend.apps.agents.core.fault_injection import KNOWN_FAULTS, armed, unknown_faults
from backend.apps.agents.core.error_classify import has_auth_status, is_content_policy_block

TURN_RUNNER = "backend/apps/agents/manager/run/TurnRunner.py"


@pytest.fixture(autouse=True)
def p_clean(monkeypatch):
    monkeypatch.delenv("OSW_FAULT", raising=False)


def p_injected(kind: str) -> str:
    """The literal the harness raises, read out of the source so the test cannot drift from it."""
    src = open(TURN_RUNNER).read()
    block = src.split(f'p_fault_armed("{kind}")')[1].split("if p_fault_armed")[0]
    return "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', block)).replace('\\"', '"')


def test_inert_unless_armed():
    assert armed("policy_block") is False
    assert armed("auth_401") is False


def test_arming_is_explicit_and_typos_are_surfaced(monkeypatch):
    monkeypatch.setenv("OSW_FAULT", "policy_block,auth_401")
    assert armed("policy_block") and armed("auth_401")
    assert not armed("sidecar_wedge"), "only what was named may arm"
    monkeypatch.setenv("OSW_FAULT", "policyblock")
    assert armed("policy_block") is False
    assert unknown_faults() == {"policyblock"}, "a typo must be reported, never silently arm nothing"


def test_the_policy_fault_is_what_the_real_classifier_catches():
    assert is_content_policy_block(p_injected("policy_block")), \
        "if this drifts, the drill fires a fault the guard ignores and still reports a pass"
    assert not is_content_policy_block("API Error: 500 internal server error")


def test_the_auth_fault_is_what_the_real_classifier_catches():
    assert has_auth_status(p_injected("auth_401"))
    # ENG-365's control: a traceback line number must never read as an auth failure.
    assert not has_auth_status("File runner.py, line 401, in execute")


def test_every_known_fault_is_wired_or_declared():
    src = open(TURN_RUNNER).read()
    wired = {m for m in KNOWN_FAULTS if f'p_fault_armed("{m}")' in src}
    assert {"policy_block", "auth_401", "transport_death"} <= wired
