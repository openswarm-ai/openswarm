"""The turn gate is the product rule (no suggestions until the chat has real shape), so it is
pinned independently of the aux call, which is fail-open and never exercised here."""

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.predict_followups import followups_eligible, conversation_tail


def p_session(*roles: str) -> AgentSession:
    s = AgentSession(name="t", model="sonnet")
    s.messages = [Message(role=r, content=f"m{i}", branch_id="main") for i, r in enumerate(roles)]
    return s


def test_empty_chat_is_not_eligible():
    assert followups_eligible(p_session()) is False


def test_one_exchange_is_not_eligible():
    assert followups_eligible(p_session("user", "assistant")) is False


def test_two_exchanges_are_eligible():
    assert followups_eligible(p_session("user", "assistant", "user", "assistant")) is True


def test_unanswered_user_spam_is_not_eligible():
    assert followups_eligible(p_session("user", "user", "user", "user")) is False


def test_hidden_user_turns_do_not_count():
    s = p_session("user", "assistant", "user", "assistant")
    s.messages[2].hidden = True
    assert followups_eligible(s) is False


def test_tool_noise_does_not_count_as_exchanges():
    s = p_session("user", "tool_call", "tool_result", "assistant", "tool_call", "assistant")
    assert followups_eligible(s) is False


def test_tail_contains_only_visible_user_assistant_text():
    # Asserts WHICH turns survive, not how they are labelled: the labels changed deliberately when
    # role-tagged replay was removed from every renderer bound for a model (ENG-396).
    s = p_session("user", "tool_call", "assistant")
    tail = conversation_tail(s)
    assert "m0" in tail and "m2" in tail, "both visible turns must survive"
    assert "m1" not in tail, "tool noise is not part of the tail"


def test_tail_caps_giant_messages():
    s = p_session("user", "assistant")
    s.messages[0].content = "x" * 5000
    tail = conversation_tail(s)
    assert len(tail) < 2000 and tail.count("...") >= 1
