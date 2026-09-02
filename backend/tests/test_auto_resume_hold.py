"""Auto-resume must be holdable by the app, and must say so instead of claiming a test run.

ENG-400: after two dirty exits in ten minutes the desktop app arms safe mode. Auto-resume fires the
very turn that was running when the app died, which is the fastest route straight back into the
crash, so main now sets OSW_DISABLE_AUTO_RESUME for that one boot. The gate already existed for the
test suite (ENG-388); reusing it meant production would log "running under test", which is a lie in
the one log line someone reads while their app is crash-looping.
"""

import sys

import pytest

from backend.apps.agents.manager.session import SessionPersistence as p_sp


@pytest.fixture(autouse=True)
def p_clean_env(monkeypatch):
    monkeypatch.delenv("OSW_DISABLE_AUTO_RESUME", raising=False)


def test_the_declared_signal_holds_it_and_names_a_reason(monkeypatch):
    monkeypatch.setenv("OSW_DISABLE_AUTO_RESUME", "1")
    why = p_sp.auto_resume_held_because()
    assert why, "the env var is the declared signal"
    assert "test" in why and "safe mode" in why, "the reason must cover BOTH callers, not just pytest"


def test_only_an_explicit_one_disarms_resume(monkeypatch):
    # A stray empty value must never silently kill crash-resume: that is work vanishing quietly.
    monkeypatch.setenv("OSW_DISABLE_AUTO_RESUME", "")
    monkeypatch.setitem(sys.modules, "pytest", None)
    del sys.modules["pytest"]
    try:
        assert p_sp.auto_resume_held_because() is None
    finally:
        import pytest as p_mod
        sys.modules["pytest"] = p_mod


def test_pytest_still_holds_it_as_the_fallback():
    assert "pytest" in sys.modules
    assert p_sp.auto_resume_held_because() == "pytest is loaded"


def test_the_old_boolean_still_answers_for_existing_callers(monkeypatch):
    monkeypatch.setenv("OSW_DISABLE_AUTO_RESUME", "1")
    assert p_sp.running_under_test() is True


def test_the_log_line_names_what_was_not_resumed():
    src = open("backend/apps/agents/manager/session/SessionPersistence.py").read()
    i = src.index("p_held = auto_resume_held_because()")
    body = src[i:i + 400]
    assert "NOT auto-resumed because" in body
    assert "Resume chip" in body, "the user has to know the work is still there"
    assert "running under test" not in body, "production must not be told it is a test run"
