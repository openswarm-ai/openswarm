"""Rigorous coverage for the token-accounting + compaction-trigger logic lifted into
manager/context_budget.py. Compaction is correctness-sensitive (backend/CLAUDE.md), so
every branch of maybe_compact is pinned, plus emit_context_update's token persistence and
the exact broadcast payload."""

import asyncio

import backend.apps.agents.manager.context_budget as cb
import backend.apps.agents.manager.run.run_options_helpers as roh
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.session.history_compaction import SPILL_HEAD_CHARS, SPILL_TAIL_CHARS, build_history_prefix, clamp_recap_text


def p_session_with(messages: int, input_tokens: int, context_window: int = 100, threshold: float = 0.65) -> AgentSession:
    s = AgentSession(name="t", model="sonnet")
    s.context_window = context_window
    s.compact_threshold_pct = threshold
    s.tokens = {"input": input_tokens, "output": 0}
    s.messages = [Message(role="user", content=f"m{i}") for i in range(messages)]
    return s


def p_capture_ws(monkeypatch):
    sent = []

    async def fake_send(session_id, event, data):
        sent.append((event, data))

    monkeypatch.setattr(cb.ws_manager, "send_to_session", fake_send, raising=True)
    return sent


# ---- maybe_compact: every branch -------------------------------------------

def test_compact_skipped_below_threshold():
    s = p_session_with(messages=10, input_tokens=10)  # 0.10 < 0.65
    assert cb.maybe_compact(s) is False
    assert s.compacted_through_msg_id is None


def test_compact_fires_over_threshold_and_marks_boundary():
    s = p_session_with(messages=7, input_tokens=80)   # 0.80 >= 0.65; cutoff = 7-6 = 1
    assert cb.maybe_compact(s) is True
    assert s.compacted_through_msg_id == s.messages[0].id


def test_compact_keeps_the_last_six_messages():
    s = p_session_with(messages=10, input_tokens=80)  # cutoff = 10-6 = 4 -> boundary at msgs[3]
    assert cb.maybe_compact(s) is True
    assert s.compacted_through_msg_id == s.messages[3].id


def test_compact_skipped_with_six_or_fewer_messages():
    s = p_session_with(messages=6, input_tokens=80)   # cutoff = max(0, 6-6) = 0
    assert cb.maybe_compact(s) is False


def test_compact_skipped_under_four_messages():
    s = p_session_with(messages=3, input_tokens=80)
    assert cb.maybe_compact(s) is False


def test_compact_is_idempotent():
    s = p_session_with(messages=7, input_tokens=80)
    assert cb.maybe_compact(s) is True
    boundary = s.compacted_through_msg_id
    assert cb.maybe_compact(s) is False              # already marked through that id
    assert s.compacted_through_msg_id == boundary


def test_force_bypasses_threshold_and_idempotency():
    s = p_session_with(messages=7, input_tokens=1)    # 0.01 < 0.65
    assert cb.maybe_compact(s, force=True) is True   # force ignores the ratio
    assert cb.maybe_compact(s, force=True) is True   # force re-marks even when unchanged


# ---- absolute ceiling: "not just 65%" on big windows -----------------------

def test_abs_ceiling_fires_earlier_than_pct_on_a_big_window():
    # 1M window, 200K used = 0.20: below the 0.65 pct but above the 180K ceiling (0.18), so it fires.
    s = p_session_with(messages=7, input_tokens=200_000, context_window=1_000_000)
    assert cb.maybe_compact(s) is True


def test_abs_ceiling_does_not_fire_below_it_on_a_big_window():
    s = p_session_with(messages=7, input_tokens=150_000, context_window=1_000_000)  # 0.15 < 0.18
    assert cb.maybe_compact(s) is False


def test_small_window_still_governed_by_pct():
    # 200K window: 130K (0.65) is tighter than the 180K ceiling, so pct still rules.
    s = p_session_with(messages=7, input_tokens=120_000, context_window=200_000)  # 0.60 < 0.65
    assert cb.maybe_compact(s) is False
    s2 = p_session_with(messages=7, input_tokens=140_000, context_window=200_000)  # 0.70 >= 0.65
    assert cb.maybe_compact(s2) is True


# ---- emit_context_update ----------------------------------------------------

def test_emit_persists_tokens_and_broadcasts(monkeypatch):
    sent = p_capture_ws(monkeypatch)
    s = AgentSession(name="t", model="sonnet")
    s.context_window = 1000

    asyncio.run(cb.emit_context_update("sid", s, input_tokens=250, output_tokens=40, cache_read_tokens=10, cache_read_pct=0.5))

    assert s.tokens["input"] == 250 and s.tokens["output"] == 40
    assert len(sent) == 1
    event, data = sent[0]
    assert event == "agent:context_update"
    assert data["input_tokens"] == 250 and data["output_tokens"] == 40
    assert data["cache_read_tokens"] == 10 and data["cache_read_pct"] == 0.5
    assert data["ctx_used_pct"] == round(250 / 1000, 4)
    assert data["context_window"] == 1000


def test_emit_defaults_to_existing_session_tokens(monkeypatch):
    sent = p_capture_ws(monkeypatch)
    s = AgentSession(name="t", model="sonnet")
    s.tokens = {"input": 123, "output": 7}

    asyncio.run(cb.emit_context_update("sid", s))  # no explicit tokens -> reuse the session's
    _, data = sent[0]
    assert data["input_tokens"] == 123 and data["output_tokens"] == 7


def test_emit_zero_input_yields_zero_ctx_pct(monkeypatch):
    sent = p_capture_ws(monkeypatch)
    s = AgentSession(name="t", model="sonnet")

    asyncio.run(cb.emit_context_update("sid", s, input_tokens=0))
    _, data = sent[0]
    assert data["ctx_used_pct"] == 0.0

# ---- pre_send_context_guard: the threshold now pays for the rebuild ---------

class P_GuardManager:
    def maybe_compact(self, session, force=False):
        return cb.maybe_compact(session, force)

    async def emit_context_update(self, session_id, session, **kwargs):
        return None


def p_run_guard(monkeypatch, session):
    async def fake_send(session_id, event, data):
        return None
    monkeypatch.setattr(roh.ws_manager, "send_to_session", fake_send, raising=True)
    asyncio.run(roh.pre_send_context_guard(P_GuardManager(), session, session.id))


def test_threshold_compaction_forces_the_rebuild(monkeypatch):
    # Marking alone never applied on the resume path (the CLI replays its own untrimmed transcript), so crossing the threshold must also drop the SDK convo.
    s = p_session_with(messages=10, input_tokens=80)
    p_run_guard(monkeypatch, s)
    assert s.compacted_through_msg_id is not None
    assert s.needs_fresh_session is True


def test_below_threshold_keeps_the_resume_session(monkeypatch):
    s = p_session_with(messages=10, input_tokens=10)
    p_run_guard(monkeypatch, s)
    assert s.compacted_through_msg_id is None
    assert s.needs_fresh_session is False


# ---- recap clamp: a pasted log can't ride through compaction verbatim ------

def test_recap_clamps_giant_messages_and_keeps_both_ends():
    giant = "HEAD" + ("x" * (SPILL_HEAD_CHARS + SPILL_TAIL_CHARS + 10_000)) + "TAIL"
    msgs = [Message(role="user", content=giant), Message(role="assistant", content="ok")]
    recap = build_history_prefix(msgs)
    assert "HEAD" in recap and "TAIL" in recap
    assert "chars elided from recap" in recap
    assert len(recap) < len(giant)


def test_recap_leaves_normal_messages_verbatim():
    text = "a perfectly ordinary message"
    assert clamp_recap_text(text) == text
    recap = build_history_prefix([Message(role="user", content=text)])
    assert text in recap and "elided" not in recap

# ---- mid-turn breaker: one giant turn can't blow past every wall ------------

from backend.apps.agents.manager.streaming.state import TurnState

def p_usage(total: int) -> dict:
    return {"input_tokens": total - 200, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 100, "output_tokens": 5}


def test_midturn_break_fires_on_crossing_and_arms_the_continuation():
    s = p_session_with(messages=10, input_tokens=0, context_window=1_000_000)
    t = TurnState()
    assert cb.maybe_break_midturn(s, t, p_usage(50_000)) is False
    assert t.saw_input_below_trigger is True
    assert cb.maybe_break_midturn(s, t, p_usage(200_000)) is True
    assert t.context_break_fired is True
    assert s.needs_fresh_session is True
    assert s.pending_continuation is True
    assert s.compacted_through_msg_id is not None
    assert s.tokens["input"] == 200_000


def test_midturn_break_fires_once_per_turn():
    s = p_session_with(messages=10, input_tokens=0, context_window=1_000_000)
    t = TurnState()
    cb.maybe_break_midturn(s, t, p_usage(50_000))
    assert cb.maybe_break_midturn(s, t, p_usage(200_000)) is True
    assert cb.maybe_break_midturn(s, t, p_usage(300_000)) is False


def test_a_turn_that_starts_high_and_does_not_grow_is_left_alone():
    """A rebuild that failed to shrink must RUN. Growth, not an absolute reading, is what makes a
    turn this guard's business."""
    s = p_session_with(messages=10, input_tokens=0, context_window=1_000_000)
    t = TurnState()
    assert cb.maybe_break_midturn(s, t, p_usage(500_000)) is False
    assert cb.maybe_break_midturn(s, t, p_usage(505_000)) is False, "5K is not material growth"
    assert t.context_break_fired is False


def test_a_turn_that_starts_high_and_GROWS_does_break():
    """The hole this closed. Measured live: the first usage reading a turn delivers was 94,404
    against a 45,000 trigger, so the old below-trigger-first rule sat the guard out for the whole
    turn -- which in production is every long chat and every resumed session near its ceiling."""
    s = p_session_with(messages=10, input_tokens=0, context_window=1_000_000)
    t = TurnState()
    assert cb.maybe_break_midturn(s, t, p_usage(500_000)) is False
    assert cb.maybe_break_midturn(s, t, p_usage(600_000)) is True
    assert s.pending_continuation and s.needs_fresh_session
    assert s.last_break_input_tokens == 600_000


def test_a_rebuild_that_did_not_shrink_cannot_break_LOOP():
    """The anti-loop, at the session level where it belongs: break once, and if the rebuild lands
    back at or above where we broke, the next turn RUNS instead of rebuilding forever."""
    s = p_session_with(messages=10, input_tokens=0, context_window=1_000_000)
    t = TurnState()
    cb.maybe_break_midturn(s, t, p_usage(500_000))
    assert cb.maybe_break_midturn(s, t, p_usage(600_000)) is True

    t2 = TurnState()   # the rebuilt turn, no smaller than the break
    assert cb.maybe_break_midturn(s, t2, p_usage(600_000)) is False
    assert cb.maybe_break_midturn(s, t2, p_usage(700_000)) is False
    assert t2.context_break_fired is False


def test_a_rebuild_that_DID_shrink_is_protected_again():
    """The other direction, which is the half that is easy to lose: the anti-loop must not become a
    one-break-per-session cap."""
    s = p_session_with(messages=10, input_tokens=0, context_window=1_000_000)
    t = TurnState()
    cb.maybe_break_midturn(s, t, p_usage(500_000))
    assert cb.maybe_break_midturn(s, t, p_usage(600_000)) is True

    t2 = TurnState()
    assert cb.maybe_break_midturn(s, t2, p_usage(40_000)) is False
    assert cb.maybe_break_midturn(s, t2, p_usage(300_000)) is True, "a shrunk rebuild is breakable again"


def test_midturn_break_zero_or_garbage_usage_is_inert():
    s = p_session_with(messages=10, input_tokens=7, context_window=1_000_000)
    t = TurnState()
    assert cb.maybe_break_midturn(s, t, {}) is False
    assert cb.maybe_break_midturn(s, t, {"input_tokens": "nope"}) is False
    assert s.tokens["input"] == 7


def test_trigger_formula_matches_maybe_compact():
    s = p_session_with(messages=10, input_tokens=0, context_window=1_000_000)
    assert cb.compact_trigger_tokens(s) == 180_000
    s2 = p_session_with(messages=10, input_tokens=0, context_window=200_000)
    assert cb.compact_trigger_tokens(s2) == 130_000
