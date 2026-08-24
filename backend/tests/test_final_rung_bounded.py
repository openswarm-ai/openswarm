"""The nudge ladder's last rung must not die of the same cause as the first two.

Field data from the install whose 369 silent quits were read one by one: the nudge-1/2/3 medians
climb 181 -> 203 -> 285 tool calls and 105K -> 125K -> 135K input. The ladder gets DEEPER at each
rung, so rung 3 was walking into the very context that had just eaten rungs 1 and 2, with tools
taken away. Compaction before the nudge could not save it because it is gated on reclaiming 20K.

These pin that the last rung is bounded BY CONSTRUCTION, and that the bound can never widen a
policy ratchet back open.
"""

import pytest

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run import empty_finish as ef
from backend.apps.agents.manager.run.RunOptions import p_effective_prefix_mode, P_PREFIX_NARROWNESS


def p_deep_session(input_tokens: int, nudges: int) -> AgentSession:
    s = AgentSession(name="deep", model="sonnet", dashboard_id="d")
    s.tokens = {"input": input_tokens}
    s.empty_finish_nudges = nudges
    s.empty_finish_total = nudges
    s.messages = [Message(role="user", content="do the thing")]
    for i in range(30):
        s.messages.append(Message(role="tool_call", content={"tool": "Bash", "input": {"command": f"c{i}"}}))
        s.messages.append(Message(role="tool_result", content={"tool_name": "Bash", "text": "x" * 400}))
    return s


def test_the_last_rung_is_bounded_when_the_context_is_deep(monkeypatch):
    import backend.apps.agents.manager.context_budget as cb
    monkeypatch.setattr(cb, "maybe_compact", lambda s, force=False: True, raising=True)
    s = p_deep_session(135_000, ef.NUDGE_HARD_CAP - 1)
    ef.maybe_nudge_empty_finish(s, s.id)
    assert s.history_prefix_once == "summary", \
        "the last rung must carry a gist, not the context that already killed two rungs"
    assert s.needs_fresh_session is True
    assert s.pending_continuation_toolless is True, "and it still drops tools, as before"


def test_an_earlier_rung_is_left_alone(monkeypatch):
    # A control: bounding rung 1 would pay a rebuild on every hiccup, which is the ENG-354 mistake.
    import backend.apps.agents.manager.context_budget as cb
    monkeypatch.setattr(cb, "maybe_compact", lambda s, force=False: True, raising=True)
    s = p_deep_session(135_000, 0)
    ef.maybe_nudge_empty_finish(s, s.id)
    assert s.history_prefix_once is None
    assert s.pending_continuation_toolless is False


def test_a_shallow_last_rung_pays_nothing(monkeypatch):
    # Below the measured quit floor (68K) depth is not the cause, so a rebuild would buy nothing.
    import backend.apps.agents.manager.context_budget as cb
    monkeypatch.setattr(cb, "maybe_compact", lambda s, force=False: True, raising=True)
    s = p_deep_session(20_000, ef.NUDGE_HARD_CAP - 1)
    ef.maybe_nudge_empty_finish(s, s.id)
    assert s.history_prefix_once is None, "a small last rung does not need bounding"


def test_the_bound_can_never_widen_a_policy_ratchet():
    # The ratchet is at "none" because a recap-bearing turn was REFUSED. A one-turn override that
    # widened it back would hand the filter the exact request it just declined.
    s = AgentSession(name="blocked", model="sonnet", dashboard_id="d")
    s.history_prefix_mode = "none"
    s.history_prefix_once = "summary"
    assert p_effective_prefix_mode(s) == "none"


def test_the_override_is_consumed_so_it_cannot_leak_into_later_turns():
    s = AgentSession(name="once", model="sonnet", dashboard_id="d")
    s.history_prefix_once = "summary"
    assert p_effective_prefix_mode(s) == "summary"
    assert s.history_prefix_once is None
    assert p_effective_prefix_mode(s) == "minimal", "the turn after must be normal again"


def test_summary_mode_sends_no_authored_trail_at_all():
    # The whole point: bounded BY CONSTRUCTION. "summary" carries the model's own distilled gist and
    # nothing we wrote from its turns, so the request size does not depend on how big history got.
    src = open("backend/apps/agents/manager/run/RunOptions.py").read()
    assert 'history = "" if p_mode in ("none", "summary")' in src
    assert 'distilled_history_summary(session, global_settings) if p_mode != "none"' in src, \
        "summary mode must still fetch the gist, or the last rung carries nothing"


def test_the_narrowing_order_is_declared_not_alphabetical():
    assert P_PREFIX_NARROWNESS == ("minimal", "summary", "none")


def test_the_drill_seam_is_declared_and_ignores_junk(monkeypatch):
    from backend.apps.agents.manager.run.empty_finish import p_final_rung_bound, FINAL_RUNG_BOUND_TOKENS
    assert p_final_rung_bound() == FINAL_RUNG_BOUND_TOKENS
    monkeypatch.setenv("OSW_FINAL_RUNG_BOUND_TOKENS", "1200")
    assert p_final_rung_bound() == 1200
    monkeypatch.setenv("OSW_FINAL_RUNG_BOUND_TOKENS", "not-a-number")
    assert p_final_rung_bound() == FINAL_RUNG_BOUND_TOKENS, "junk must never silently disarm the bound"
    monkeypatch.setenv("OSW_FINAL_RUNG_BOUND_TOKENS", "-5")
    assert p_final_rung_bound() == FINAL_RUNG_BOUND_TOKENS
