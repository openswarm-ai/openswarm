"""A fault harness is only useful if the fault it fires is the one the guard actually looks for.

Half the safety code only runs on rare failures, so it was never drilled: waiting for a wedged
sidecar or a provider refusal in the wild means the guard is hoped for, not proven (ENG-385's cap
measured 0.0%; ENG-391's breaker never runs on codex). These pin that the injected text is
classified the same way a REAL failure is, and that the harness is inert unless armed.
"""

import re
import pytest

import builtins

from backend.apps.agents.core.fault_injection import (
    KNOWN_FAULTS, announce, armed, armed_once, reset_fired, unknown_faults,
)
from backend.apps.agents.core.error_classify import (
    has_auth_status, is_connection_lost, is_content_policy_block,
)

TURN_RUNNER = "backend/apps/agents/manager/run/TurnRunner.py"
# Where each fault is raised. A fault this build knows but wires nowhere is the exact shape of a
# guard that never fires, so the map is the test, not a convenience.
WIRED_IN = {
    "policy_block": TURN_RUNNER,
    "auth_401": TURN_RUNNER,
    "transport_death": TURN_RUNNER,
    "empty_finish": "backend/apps/agents/manager/streaming/handle_assistant_message.py",
}


def p_block(kind: str) -> str:
    """The source of the branch that fires one fault, whichever helper name arms it."""
    src = open(WIRED_IN[kind]).read()
    for call in (f'p_fault_armed("{kind}")', f'p_fault_once("{kind}")'):
        if call in src:
            return src.split(call)[1].split("if p_fault_")[0]
    raise AssertionError(f"{kind} is armed nowhere in {WIRED_IN[kind]}")


@pytest.fixture(autouse=True)
def p_clean(monkeypatch):
    monkeypatch.delenv("OSW_FAULT", raising=False)


def p_injected(kind: str) -> str:
    """The literal the harness raises, read out of the source so the test cannot drift from it."""
    return "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', p_block(kind))).replace('\\"', '"')


def p_raised_type(kind: str) -> type:
    """The exception CLASS the harness raises, resolved for real so a rename cannot pass."""
    name = re.search(r"raise\s+([A-Za-z_][\w.]*)\(", p_block(kind)).group(1)
    if "." in name:
        import importlib
        mod, _, attr = name.rpartition(".")
        return getattr(importlib.import_module(mod), attr)
    return getattr(builtins, name)


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


def test_the_transport_fault_is_what_the_real_classifier_catches():
    # Cost a wrong verdict once: anyio.BrokenResourceError is NOT in the transient set, so the drill
    # measured the unclassified poisoned-session fall-through and read as "the transport heal is broken".
    assert is_connection_lost(p_raised_type("transport_death")("injected")), \
        "the injected type must be one the real classifier calls a lost connection"
    import anyio
    assert not is_connection_lost(anyio.BrokenResourceError()), \
        "control: the type that actually fooled this drill must still read as NOT a lost connection"


def test_a_recoverable_fault_fires_once_so_the_retry_finds_a_clear_road(monkeypatch):
    monkeypatch.setenv("OSW_FAULT", "transport_death")
    reset_fired()
    assert armed_once("transport_death") is True
    assert armed_once("transport_death") is False, \
        "a fault that fires on every attempt proves the failure and never the heal"


def test_every_known_fault_is_wired_somewhere():
    assert set(WIRED_IN) == KNOWN_FAULTS - {"sidecar_wedge"}, \
        "a fault this build knows but wires nowhere is a guard that can never be drilled"
    for kind in WIRED_IN:
        assert p_block(kind).strip(), f"{kind} has an empty branch"


def test_arming_is_announced_and_a_typo_is_named(monkeypatch, caplog):
    # The harness built to kill row-6 silence had it: unknown_faults() existed and NOTHING called it,
    # so a mistyped name armed nothing while the drill exercised the untouched happy path.
    monkeypatch.setenv("OSW_FAULT", "policy_block,plicy_blok")
    with caplog.at_level("WARNING"):
        announce()
    assert "policy_block" in caplog.text and "plicy_blok" in caplog.text
    caplog.clear()
    monkeypatch.delenv("OSW_FAULT")
    with caplog.at_level("WARNING"):
        announce()
    assert caplog.text == "", "a shipped build must say nothing at all"


def test_the_boot_path_actually_announces():
    src = open("backend/apps/agents/agents.py").read()
    assert "p_announce_armed_faults()" in src, \
        "an announcement nothing calls is the silence it was written to prevent"
