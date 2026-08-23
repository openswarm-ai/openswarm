"""The mid-turn context breaker has to be drillable, or it only ever gets reasoned about.

Three attempts to fire it live (2026-08-22) failed: the empty-finish path is not inducible by
prompt (the model always writes text), and the breaker itself needs a genuine 180K-token turn,
which costs real money and died to a lane 401 twice. `OSW_COMPACT_CEILING_TOKENS` lowers the bar
so the SAME code path runs in seconds. It must be inert unless deliberately set, and it must not
trust a junk value.
"""

import os

import pytest

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.context_budget import compact_ceiling_tokens, compact_trigger_tokens


def p_session(window: int = 1_000_000) -> AgentSession:
    s = AgentSession(name="t", model="opus-5")
    s.context_window = window
    return s


@pytest.fixture(autouse=True)
def p_clean_env(monkeypatch):
    monkeypatch.delenv("OSW_COMPACT_CEILING_TOKENS", raising=False)


def test_unset_is_exactly_todays_behaviour():
    s = p_session()
    assert compact_ceiling_tokens(s) == s.compact_abs_ceiling_tokens == 180_000
    assert compact_trigger_tokens(s) == 180_000


def test_the_override_lowers_the_trigger(monkeypatch):
    monkeypatch.setenv("OSW_COMPACT_CEILING_TOKENS", "20000")
    assert compact_trigger_tokens(p_session()) == 20_000


def test_a_junk_value_is_ignored_not_trusted(monkeypatch):
    for junk in ("banana", "", "  ", "1e5", "0", "-5"):
        monkeypatch.setenv("OSW_COMPACT_CEILING_TOKENS", junk)
        assert compact_ceiling_tokens(p_session()) == 180_000, f"junk {junk!r} must not change the ceiling"


def test_the_pct_threshold_still_wins_when_it_is_tighter(monkeypatch):
    # On a 200K window the pct (0.65 -> 130K) is tighter than a 180K ceiling; an override must not
    # be able to raise the trigger above what the percentage already allows.
    s = p_session(window=200_000)
    assert compact_trigger_tokens(s) == 130_000
    monkeypatch.setenv("OSW_COMPACT_CEILING_TOKENS", "900000")
    assert compact_trigger_tokens(s) == 130_000
