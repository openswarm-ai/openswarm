"""Pins the content-policy-block contract (Alex's bricked-chat class): the provider's ToS/AUP
refusal is terminal (no retry ladder, no snag flicker), a recap-bearing session gets exactly ONE
silent retry without the recap, and the recap itself no longer reads as a User:/Assistant:
transcript replay (the shape provider distillation filters flag)."""

from backend.apps.agents.core.error_classify import is_transient_capacity_error
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.handle_run_error import p_is_content_policy_block
from backend.apps.agents.manager.session.history_compaction import build_history_prefix

TOS_TEXT = (
    "API Error: 400 (request id: req_x) https://www.anthropic.com/legal/aup). This request was "
    "blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse "
    "engineering or duplicating model outputs."
)


def test_tos_block_detected():
    assert p_is_content_policy_block(TOS_TEXT) is True
    assert p_is_content_policy_block("ordinary overloaded_error 529") is False


def test_tos_block_never_transient():
    """The retry ladder hammering this deterministic 400 was the snag-chip flicker."""
    assert is_transient_capacity_error(Exception(TOS_TEXT)) is False


def test_recap_is_first_person_not_transcript():
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="user", content="find candidates for the role"))
    s.messages.append(Message(role="assistant", content="I found three strong profiles."))
    recap = build_history_prefix(s.messages)
    assert "You replied:" in recap
    assert "The user asked:" in recap
    assert "\nAssistant: " not in recap, "bare transcript labels pattern-match distillation filters"
    assert "\nUser: " not in recap
    assert "YOUR OWN earlier turns" in recap


def test_policy_fields_default_off():
    s = AgentSession(name="t", model="sonnet")
    assert s.policy_retry_used is False
    assert s.suppress_recap_once is False


def test_policy_block_arms_one_recap_free_retry(monkeypatch):
    """The drill-found gate bug: a fresh-session recap block must arm the silent retry even when
    compacted_through_msg_id is still None (the recap is sent before any compaction mark exists)."""
    import asyncio
    from backend.apps.agents.manager.run.handle_run_error import handle_run_error
    from backend.apps.agents.manager.streaming.state import TurnState
    s = AgentSession(name="t", model="opus-5")
    s.messages.append(Message(role="user", content="do the thing"))
    s.messages.append(Message(role="tool_call", content={"tool": "Read", "input": {}}))
    s.messages.append(Message(role="tool_result", content={"text": "x" * 300}))
    assert s.compacted_through_msg_id is None
    asyncio.run(handle_run_error(Exception(TOS_TEXT), s, "sid-pol", TurnState(), []))
    assert s.policy_retry_used is True
    assert s.suppress_recap_once is True
    assert s.pending_continuation is True
    assert not any(m.role == "system" for m in s.messages), "retry turn must be silent, no card yet"


def test_second_policy_block_renders_the_terminal_card():
    import asyncio
    from backend.apps.agents.manager.run.handle_run_error import handle_run_error
    from backend.apps.agents.manager.streaming.state import TurnState
    s = AgentSession(name="t", model="opus-5")
    s.messages.append(Message(role="user", content="do the thing"))
    s.messages.append(Message(role="assistant", content="working"))
    s.policy_retry_used = True
    asyncio.run(handle_run_error(Exception(TOS_TEXT), s, "sid-pol2", TurnState(), []))
    cards = [m for m in s.messages if m.role == "system"]
    assert len(cards) == 1 and "declined this request" in str(cards[0].content)
