"""A blocked chat retried, blocked, retried, blocked (Ken, 2026-08-31; envelopes 2026-08-30).

The ratchet keyed on `history_prefix_sent`, which is an OUTCOME: RunOptions sets it to "none" at the
top of every turn and only overwrites it when a fresh-session rebuild actually attaches a recap. On a
RESUMED turn nothing is attached, so it reads "none" while the declared mode is still "minimal".

The handler read that "none" as "nothing left to strip", skipped the ladder, and went straight to the
terminal card WITHOUT narrowing anything. The next rebuild therefore sent a recap again and blocked
again. The fleet shows the impossible sequence that proves it: one session, three blocks, sent going
none -> minimal -> none, when ENG-399 says a session ratcheted to none is never widened back.

Rule this restores: never key a guard on an incidental fact; use the DECLARED signal.
"""
import pytest

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.run.RunOptions import PREFIX_NARROWNESS


def p_session(mode, sent):
    s = AgentSession(name="t", model="sonnet", dashboard_id="d")
    s.history_prefix_mode = mode
    s.history_prefix_sent = sent
    return s


def test_sent_is_an_outcome_not_the_state():
    """The field the old code trusted defaults to 'none' on a turn that simply resumed."""
    import inspect
    from backend.apps.agents.manager.run import RunOptions
    src = inspect.getsource(RunOptions)
    assert 'session.history_prefix_sent = "none"' in src, (
        "if this default ever goes away, the bug's premise changes and this file should be re-read"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,expected", [("minimal", "summary"), ("summary", "none")])
async def test_a_block_on_a_RESUMED_turn_still_narrows(monkeypatch, mode, expected):
    """sent='none' (nothing attached) while the mode is wider: the ladder MUST still step."""
    from backend.apps.agents.manager.run import handle_run_error as mod
    from backend.apps.agents.manager.streaming.state import TurnState

    async def p_send(*a, **k):
        return None
    monkeypatch.setattr(mod.ws_manager, "send_to_session", p_send)
    monkeypatch.setattr(mod, "p_report_model_error", lambda *a, **k: None)

    s = p_session(mode, "none")
    err = RuntimeError(
        'API Error: 400 {"error":{"message":"Output blocked as it seems to violate our '
        'Acceptable Use Policy (legal/aup): reverse engineering or duplicating model outputs"}}'
    )
    await mod.handle_run_error(err, s, s.id, TurnState(), [])

    assert s.history_prefix_mode == expected, "the declared mode must narrow one step"
    assert s.pending_continuation is True, "and the narrowed retry must actually be armed"
    assert [m for m in s.messages if m.role == "system"] == [], "no terminal card while the ladder has room"


@pytest.mark.asyncio
async def test_only_an_EXHAUSTED_ladder_reaches_the_terminal_card(monkeypatch):
    from backend.apps.agents.manager.run import handle_run_error as mod
    from backend.apps.agents.manager.streaming.state import TurnState

    async def p_send(*a, **k):
        return None
    monkeypatch.setattr(mod.ws_manager, "send_to_session", p_send)
    monkeypatch.setattr(mod, "p_report_model_error", lambda *a, **k: None)
    monkeypatch.setattr(mod, "api_key_twin_model", lambda *a, **k: None)  # no own key, like the field

    s = p_session("none", "none")
    await mod.handle_run_error(RuntimeError("blocked ... legal/aup ... duplicating model outputs"),
                               s, s.id, TurnState(), [])
    cards = [m for m in s.messages if m.role == "system"]
    assert cards, "with nothing left to strip the user is owed the honest card"
    assert "start a fresh chat" in cards[-1].content.lower()
    assert s.pending_continuation is False, "and it must NOT keep retrying a request that cannot pass"


def test_the_ladder_only_ever_narrows():
    assert PREFIX_NARROWNESS == ("minimal", "summary", "none")
    for i, mode in enumerate(PREFIX_NARROWNESS[:-1]):
        assert PREFIX_NARROWNESS.index(PREFIX_NARROWNESS[i + 1]) > PREFIX_NARROWNESS.index(mode)
