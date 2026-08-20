"""A retry ladder re-failing the same way must bump the existing error card, not stack a wall of
identical "hit a snag" clones (field screenshot 2026-08-19); a user message in between always
earns a fresh card."""

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.handle_run_error import p_absorb_repeat_card


def p_card(text: str) -> Message:
    return Message(role="system", content=text, branch_id="main")


def test_identical_consecutive_card_is_absorbed():
    s = AgentSession(name="t", model="sonnet")
    first = p_card("That one failed.")
    p_absorb_repeat_card(s, first)
    repeat = p_card("That one failed.")
    p_absorb_repeat_card(s, repeat)
    assert len(s.messages) == 1
    assert repeat.id == first.id, "the bump must reuse the id so the frontend updates in place"


def test_a_user_message_in_between_earns_a_fresh_card():
    s = AgentSession(name="t", model="sonnet")
    p_absorb_repeat_card(s, p_card("That one failed."))
    s.messages.append(Message(role="user", content="try again", branch_id="main"))
    p_absorb_repeat_card(s, p_card("That one failed."))
    assert len([m for m in s.messages if m.role == "system"]) == 2


def test_different_error_text_always_appends():
    s = AgentSession(name="t", model="sonnet")
    p_absorb_repeat_card(s, p_card("Error A"))
    p_absorb_repeat_card(s, p_card("Error B"))
    assert len(s.messages) == 2


def test_other_branch_cards_do_not_mask():
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="system", content="Same text", branch_id="side"))
    p_absorb_repeat_card(s, p_card("Same text"))
    assert len(s.messages) == 2, "a card on another branch is invisible here and must not absorb"
