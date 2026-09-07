"""OpenSwarm Pro's shared pool with nothing to serve with is a person's problem, not a transient: the chat says so once and stops."""
import inspect

import pytest

from backend.apps.agents.core.error_classify import is_pool_outage, is_transient_capacity_error
from backend.apps.agents.core.models import AgentSession

P_POOL_503 = 'API Error: 503 {"error":{"message":"No pool capacity available. Try again shortly."}}'
P_BACKUP_503 = "API Error: 503 Primary account failed auth, no backup available."


def test_the_proxy_words_are_recognised_and_stay_transient_for_the_silent_backoffs():
    for text in (P_POOL_503, P_BACKUP_503):
        assert is_pool_outage(RuntimeError(text))
        assert is_transient_capacity_error(RuntimeError(text)), "the first 335 s of silent retries still run; a busy second heals there"
    assert not is_pool_outage(RuntimeError("API Error: 503 Service Unavailable"))
    assert not is_pool_outage(RuntimeError("overloaded_error"))


@pytest.mark.asyncio
async def test_past_the_backoffs_the_turn_ends_with_the_pro_card_and_never_parks(monkeypatch):
    from backend.apps.agents.manager.run import handle_run_error as mod
    from backend.apps.agents.manager.streaming.state import TurnState

    sent = []

    async def p_send(session_id, event, payload):
        sent.append((event, payload))

    monkeypatch.setattr(mod.ws_manager, "send_to_session", p_send)
    envelopes = []
    from backend.apps.service import client as p_client
    monkeypatch.setattr(p_client, "submit_diagnostic", lambda d: envelopes.append(d))
    s = AgentSession(name="t", model="sonnet-5", dashboard_id="d")
    await mod.handle_run_error(RuntimeError(P_POOL_503), s, s.id, TurnState(), [])

    events = [e for e, _ in sent]
    assert "agent:reconnect_wait" not in events, "a dead pool must not park the chat on the 60/300/900 s ladder"
    assert "agent:auth_error" in events and "agent:message" in events
    reason = next(p for e, p in sent if e == "agent:auth_error")["reason"]
    assert reason == "openswarm_pro_unavailable"
    cards = [m for m in s.messages if m.role == "system"]
    assert len(cards) == 1 and "OpenSwarm Pro" in cards[0].content and "own API key" in cards[0].content
    assert s.status == "error"
    assert [d.get("subkind") for d in envelopes] == ["pro_unavailable"]


def test_the_pool_branch_sits_above_the_generic_capacity_branch():
    from backend.apps.agents.manager.run import handle_run_error as mod
    src = inspect.getsource(mod.handle_run_error)
    assert src.index("is_pool_outage(") < src.index("is_transient_capacity_error(e, extra_text=p_stderr_tail)"), "a veto goes at the top of the decision"


def test_the_sentence_names_openswarm_pro():
    from backend.apps.agents.manager.streaming.provider_error_speech import ProviderError, user_facing_sentence
    err = ProviderError(kind="overloaded", subscription_spent=False, status=503, lane=None, reset_seconds=None, raw=P_POOL_503)
    assert user_facing_sentence(err, "sonnet-5").startswith("OpenSwarm Pro")
