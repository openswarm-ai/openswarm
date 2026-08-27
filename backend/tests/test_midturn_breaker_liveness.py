"""The mid-turn context breaker must FIRE, and must say so when it structurally cannot.

ENG-391: on the codex/GPT lane assistant messages carry no usage at all (it arrives only on the
ResultMessage, at turn end), so `maybe_break_midturn` bailed on its first line for every message of
every GPT session. Its tests passed the whole time, because they only proved it does not crash.

That is the row-6 shape CLAUDE.md names: present, reachable, doing nothing, with nothing saying so.
A guard that never fires is indistinguishable from one that was never needed.
"""

import logging

import pytest

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager import context_budget as p_cb
from backend.apps.agents.manager.streaming.state import TurnState


@pytest.fixture
def p_logs():
    """Read context_budget's own records: backend/main.py sets propagate=False on `backend`, so
    caplog goes silent here the moment any test has imported the app."""
    rec: list = []

    class P_Sink(logging.Handler):
        def emit(self, r) -> None:
            rec.append(r)

    lg = logging.getLogger("backend.apps.agents.manager.context_budget")
    h = P_Sink()
    lg.addHandler(h)
    prev = lg.level
    lg.setLevel(logging.DEBUG)
    try:
        yield rec
    finally:
        lg.removeHandler(h)
        lg.setLevel(prev)


def p_session() -> AgentSession:
    s = AgentSession(id="s-gpt", name="c", title="c", model="cx/gpt-5.6")
    s.context_window = 200_000
    return s


def test_it_actually_FIRES_when_usage_crosses_the_trigger():
    """The liveness assertion the original tests never made."""
    s, t = p_session(), TurnState()
    trigger = p_cb.compact_trigger_tokens(s)
    assert p_cb.maybe_break_midturn(s, t, {"input_tokens": 10}) is False, "a low reading arms it"
    assert t.saw_input_below_trigger is True
    assert p_cb.maybe_break_midturn(s, t, {"input_tokens": trigger + 1}) is True, \
        "crossing the trigger mid-turn MUST break the turn"
    assert s.pending_continuation is True and s.needs_fresh_session is True


def test_it_fires_only_once_per_turn():
    s, t = p_session(), TurnState()
    trigger = p_cb.compact_trigger_tokens(s)
    p_cb.maybe_break_midturn(s, t, {"input_tokens": 10})
    assert p_cb.maybe_break_midturn(s, t, {"input_tokens": trigger + 1}) is True
    assert p_cb.maybe_break_midturn(s, t, {"input_tokens": trigger + 9999}) is False


def test_a_turn_that_STARTS_over_the_trigger_is_left_alone():
    """A failed shrink would break-loop forever otherwise."""
    s, t = p_session(), TurnState()
    assert p_cb.maybe_break_midturn(s, t, {"input_tokens": p_cb.compact_trigger_tokens(s) + 1}) is False


def test_no_usage_at_all_is_ANNOUNCED_not_swallowed(p_logs):
    """The GPT lane. It cannot run; it must say whose session it just stopped protecting."""
    s, t = p_session(), TurnState()
    assert p_cb.maybe_break_midturn(s, t, {}) is False
    said = " ".join(r.getMessage() for r in p_logs)
    assert "cannot run" in said
    assert "s-gpt" in said and "cx/gpt-5.6" in said, "name the session and the lane, not just the class"
    assert "ENG-391" in said


def test_the_announcement_is_once_per_turn_not_per_message(p_logs):
    """It runs on EVERY assistant message; a per-message warning would be its own bug."""
    s, t = p_session(), TurnState()
    for _ in range(12):
        p_cb.maybe_break_midturn(s, t, {})
    assert len([r for r in p_logs if "cannot run" in r.getMessage()]) == 1


def test_a_lane_WITH_usage_never_triggers_the_warning(p_logs):
    """The innocent case: Anthropic sends usage, so nothing is inert and nothing should be said."""
    s, t = p_session(), TurnState()
    p_cb.maybe_break_midturn(s, t, {"input_tokens": 500})
    assert not [r for r in p_logs if "cannot run" in r.getMessage()]
