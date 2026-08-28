"""ENG-418: the autocompact-thrash class is drillable, and our own valve is proven to fire on it.

Before this, the mid-turn breaker could only be reached by paying for a genuine 180K-token turn.
Three attempts to fire it live cost real money and failed. A guard that is never executed is
indistinguishable from one that was never needed, so the drill is the point, not a convenience.
"""

import pytest

from backend.apps.agents.core import fault_injection as fi
from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.context_budget import (
    compact_ceiling_tokens,
    compact_trigger_tokens,
    effective_window,
    maybe_break_midturn,
)
from backend.apps.agents.manager.streaming.state import TurnState


@pytest.fixture(autouse=True)
def p_clean(monkeypatch):
    monkeypatch.delenv("OSW_FAULT", raising=False)
    monkeypatch.delenv("OSW_FAULT_CLI_WINDOW", raising=False)
    monkeypatch.delenv("OSW_COMPACT_CEILING_TOKENS", raising=False)


def p_session() -> AgentSession:
    s = AgentSession(name="t", model="opus-5")
    s.context_window = 1_000_000
    return s


def test_unset_is_exactly_todays_behaviour():
    s = p_session()
    assert fi.squeezed_context_window() == 0
    assert effective_window(s) == 1_000_000
    assert compact_trigger_tokens(s) == 180_000


def test_the_squeeze_scales_us_and_the_cli_from_ONE_number(monkeypatch):
    """The trap this exists to avoid: squeeze only the CLI and it dies at 30K while our valve waits
    for 180K, so "the valve never engaged" would be an artifact of the harness. Ratio preserved."""
    s = p_session()
    p_real_ratio = compact_trigger_tokens(s) / effective_window(s)
    monkeypatch.setenv("OSW_FAULT", "cli_context_squeeze")
    assert effective_window(s) == fi.CLI_SQUEEZE_WINDOW
    assert compact_trigger_tokens(s) / effective_window(s) == pytest.approx(p_real_ratio)
    assert compact_ceiling_tokens(s) == 45_000


def test_the_cli_gets_the_same_number_this_process_reasons_about(monkeypatch):
    """Two places deriving the same budget from different inputs is how they drift; assert they
    agree by construction, and that the env var is the one the CLI actually reads."""
    monkeypatch.setenv("OSW_FAULT", "cli_context_squeeze")
    monkeypatch.setenv("OSW_FAULT_CLI_WINDOW", "450000")
    src = open("backend/apps/agents/manager/configure_provider_env.py", encoding="utf-8").read()
    assert 'p_env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = str(p_squeeze)' in src
    assert fi.squeezed_context_window() == 450_000
    assert effective_window(p_session()) == 450_000


def test_the_valve_actually_FIRES_under_the_squeeze(monkeypatch):
    """The liveness assertion the issue asks for. Not "it does not crash": it fires, on usage a
    squeezed session really produces, and it arms the continuation that saves the work."""
    monkeypatch.setenv("OSW_FAULT", "cli_context_squeeze")
    s = p_session()
    t = TurnState()
    assert maybe_break_midturn(s, t, {"input_tokens": 35_000}) is False, "must see a below-trigger step first"
    assert t.saw_input_below_trigger
    assert maybe_break_midturn(s, t, {"input_tokens": 60_000}) is True, "the valve did not engage"
    assert s.pending_continuation and s.needs_fresh_session
    assert s.pending_continuation_prompt, "a break with no continuation loses the work silently"
    assert t.context_break_fired
    assert maybe_break_midturn(s, t, {"input_tokens": 90_000}) is False, "it must fire once per turn"


def test_without_the_squeeze_the_same_usage_does_nothing(monkeypatch):
    """The negative control, inline: 60,000 tokens is a rounding error against a real 1M window, so
    a valve that fired here would be firing on nothing."""
    s = p_session()
    t = TurnState()
    maybe_break_midturn(s, t, {"input_tokens": 35_000})
    assert maybe_break_midturn(s, t, {"input_tokens": 60_000}) is False
    assert not s.pending_continuation


def test_a_junk_window_falls_back_to_the_documented_default(monkeypatch):
    monkeypatch.setenv("OSW_FAULT", "cli_context_squeeze")
    for junk in ("abc", "-5", "0", ""):
        monkeypatch.setenv("OSW_FAULT_CLI_WINDOW", junk)
        assert fi.squeezed_context_window() == fi.CLI_SQUEEZE_WINDOW


def test_it_is_a_declared_fault_so_a_typo_cannot_arm_nothing_quietly(monkeypatch):
    assert "cli_context_squeeze" in fi.KNOWN_FAULTS
    monkeypatch.setenv("OSW_FAULT", "cli_context_squeez")
    assert fi.unknown_faults() == {"cli_context_squeez"}
    assert fi.squeezed_context_window() == 0


def test_a_valve_ineligible_window_still_works_but_SAYS_SO(monkeypatch):
    """The trap that cost this drill two runs. At 30,000 the trigger is 5,400 against a ~30,257
    baseline, so every turn starts over it and the breaker correctly refuses forever; measured
    live, it ran 0 times while the CLI thrashed to death. That window is still worth having (it
    reproduces the CLI's thrash on demand), so it is allowed and announced, never silent."""
    import logging
    monkeypatch.setenv("OSW_FAULT", "cli_context_squeeze")
    monkeypatch.setenv("OSW_FAULT_CLI_WINDOW", "30000")
    p_seen = []
    h = logging.Handler()
    h.emit = lambda r: p_seen.append(r.getMessage())
    fi.logger.addHandler(h)
    try:
        assert fi.squeezed_context_window() == 30_000, "the small window is usable, not refused"
    finally:
        fi.logger.removeHandler(h)
    assert any("INELIGIBLE" in m for m in p_seen), "a drill that cannot test the valve must say so"


def test_the_default_window_leaves_the_valve_eligible():
    """The arithmetic, asserted rather than trusted: trigger must clear a real turn's baseline."""
    import os
    os.environ["OSW_FAULT"] = "cli_context_squeeze"
    try:
        assert compact_trigger_tokens(p_session()) > fi.TURN_BASELINE_TOKENS
        assert fi.CLI_SQUEEZE_WINDOW >= fi.VALVE_ELIGIBLE_WINDOW
    finally:
        os.environ.pop("OSW_FAULT", None)





def test_the_envelope_carries_the_compaction_HISTORY_not_just_a_pending_flag():
    """`compacted` is bool(needs_fresh_session), a pending-rebuild flag that says nothing about how
    often this chat has actually compacted. The fleet question ENG-418 asks needs the counts."""
    src = open("backend/apps/agents/manager/run/handle_run_error.py", encoding="utf-8").read()
    assert '"cli_compactions"' in src and '"midturn_breaks"' in src


def test_both_counters_survive_the_turn_that_incremented_them(monkeypatch):
    """Per-turn counters die with the turn, which is why a block envelope carried nothing."""
    monkeypatch.setenv("OSW_FAULT", "cli_context_squeeze")
    s = p_session()
    assert s.midturn_breaks == 0
    t = TurnState()
    maybe_break_midturn(s, t, {"input_tokens": 35_000})
    assert maybe_break_midturn(s, t, {"input_tokens": 60_000}) is True
    assert s.midturn_breaks == 1
    t2 = TurnState()
    maybe_break_midturn(s, t2, {"input_tokens": 20_000})
    assert maybe_break_midturn(s, t2, {"input_tokens": 60_000}) is True
    assert s.midturn_breaks == 2, "the count is the session's, not the turn's"


def test_the_cli_side_counter_is_wired_to_the_boundary_event():
    src = open("backend/apps/agents/manager/run/TurnRunner.py", encoding="utf-8").read()
    i = src.index('if p_subtype == "compact_boundary":')
    assert "session.cli_compactions += 1" in src[i:i + 200]


def test_a_grown_turn_still_breaks_at_most_ONCE(monkeypatch):
    """Every break is a transcript rebuild, and rebuild FREQUENCY is the subscription lane's risk
    (PROJECT.md). Growth made more turns breakable, so the once-per-turn latch is what keeps that
    from becoming more rebuilds per turn."""
    monkeypatch.setenv("OSW_FAULT", "cli_context_squeeze")
    s = p_session()
    t = TurnState()
    maybe_break_midturn(s, t, {"input_tokens": 90_000})
    assert maybe_break_midturn(s, t, {"input_tokens": 120_000}) is True
    for n in (150_000, 200_000, 400_000):
        assert maybe_break_midturn(s, t, {"input_tokens": n}) is False
    assert s.midturn_breaks == 1
