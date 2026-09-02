"""A CLI killed from outside (exit 143/137, nothing on stderr) resumes on a fresh process instead of
carding and forcing the rebuild. Seen 2026-09-01 on a forked real chat, 2 of 3 runs; the fleet carries
the same string (one install 30x in an hour, Haik 17x in 14 days)."""
import inspect
import pytest
from backend.apps.agents.core.error_classify import is_external_kill_error, is_transient_capacity_error
from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming.auth_retry import (
    EXTERNAL_KILL_RETRY_PROMPT, try_auth_self_heal, try_external_kill_self_heal, try_stale_tool_schema_self_heal,
)

REAL = "Command failed with exit code 143 (exit code: 143)\nError output: Check stderr output for details"


def p_session() -> AgentSession:
    return AgentSession(name="t", model="sonnet")


def test_the_real_143_and_a_sigkill_137_are_recognised():
    assert is_external_kill_error(RuntimeError(REAL))
    assert is_external_kill_error(RuntimeError("Command failed with exit code 137 (exit code: 137)"))


@pytest.mark.parametrize("innocent", [
    ("Command failed with exit code 1 (exit code: 1)", ""),
    ("Command failed with exit code 143 (exit code: 143)", "API Error: 401 authentication_error"),
    ("Command failed with exit code 143 (exit code: 143)", "Error: request blocked by Usage Policy"),
    ("Command failed with exit code 1430", ""),
    ("Error code: 429 - rate limit", ""),
])
def test_other_failures_never_claim_it(innocent):
    text, tail = innocent
    assert not is_external_kill_error(RuntimeError(text), extra_text=tail)


def test_it_is_not_a_transient_capacity_error_either():
    assert not is_transient_capacity_error(RuntimeError(REAL))


def test_one_respawn_then_the_budget_is_spent():
    s = p_session()
    assert try_external_kill_self_heal(s)
    assert s.needs_respawn and s.pending_continuation and s.pending_continuation_prompt == EXTERNAL_KILL_RETRY_PROMPT
    assert "verbatim" not in EXTERNAL_KILL_RETRY_PROMPT.lower()
    s.pending_continuation = False
    assert not try_external_kill_self_heal(s), "one is the whole budget"


def test_it_never_stomps_a_continuation_already_armed():
    s = p_session()
    s.pending_continuation = True
    assert not try_external_kill_self_heal(s)


def test_it_does_not_eat_the_other_one_shots():
    s = p_session()
    assert try_external_kill_self_heal(s)
    s.pending_continuation = False
    assert try_stale_tool_schema_self_heal(s), "separate budgets"
    s.pending_continuation = False
    assert try_auth_self_heal(s), "separate budgets"


def test_a_real_user_message_refills_the_budget():
    from backend.apps.agents.manager import Messaging
    src = inspect.getsource(Messaging)
    assert "session.external_kill_retry_used = False" in src


def test_the_branch_sits_above_every_card_emitting_branch():
    from backend.apps.agents.manager.run import handle_run_error as mod
    src = inspect.getsource(mod.handle_run_error)
    mine = src.index("is_external_kill_error(e")
    assert src.index("is_stale_tool_schema_error(e") < mine
    for later in ("is_context_overflow_error(e", "is_transient_capacity_error(e", "is_auth_error(e", "unclassified failure"):
        assert mine < src.index(later), f"the respawn must precede {later}"


@pytest.mark.asyncio
async def test_handle_run_error_resumes_on_a_fresh_process_and_emits_no_card(monkeypatch):
    from backend.apps.agents.manager.run import handle_run_error as mod
    from backend.apps.agents.manager.streaming.state import TurnState
    sent: list = []

    async def p_send(session_id, event, payload):
        sent.append((event, payload))

    monkeypatch.setattr(mod.ws_manager, "send_to_session", p_send)
    s = p_session(); s.dashboard_id = "d"
    await mod.handle_run_error(RuntimeError(REAL), s, s.id, TurnState(), [])
    assert s.needs_respawn is True, "resume the same transcript on a new process"
    assert s.needs_fresh_session is False, "never the rebuild: on a long chat the recap IS the cliff"
    assert s.pending_continuation is True
    assert [m for m in s.messages if m.role == "system"] == []
    assert not any(e == "agent:message" for e, _ in sent)


@pytest.mark.asyncio
async def test_the_second_kill_cards_honestly(monkeypatch):
    from backend.apps.agents.manager.run import handle_run_error as mod
    from backend.apps.agents.manager.streaming.state import TurnState

    async def p_send(session_id, event, payload):
        return None

    monkeypatch.setattr(mod.ws_manager, "send_to_session", p_send)
    s = p_session(); s.dashboard_id = "d"; s.external_kill_retry_used = True
    await mod.handle_run_error(RuntimeError(REAL), s, s.id, TurnState(), [])
    cards = [m for m in s.messages if m.role == "system"]
    assert len(cards) == 1
    low = str(cards[0].content).lower()
    assert "not openswarm" in low and "send your message again" in low
    assert "switch" not in low and "model" not in low, "the model did nothing wrong"
    assert s.needs_fresh_session is False
