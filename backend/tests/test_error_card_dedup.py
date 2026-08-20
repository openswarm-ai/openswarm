"""A retry ladder re-failing the same way must bump the existing error card, not stack a wall of
identical "hit a snag" clones (field screenshot 2026-08-19); a user message in between always
earns a fresh card."""

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.handle_run_error import absorb_repeat_card


def p_card(text: str) -> Message:
    return Message(role="system", content=text, branch_id="main")


def test_identical_consecutive_card_is_absorbed():
    s = AgentSession(name="t", model="sonnet")
    first = p_card("That one failed.")
    absorb_repeat_card(s, first)
    repeat = p_card("That one failed.")
    absorb_repeat_card(s, repeat)
    assert len(s.messages) == 1
    assert repeat.id == first.id, "the bump must reuse the id so the frontend updates in place"


def test_a_user_message_in_between_earns_a_fresh_card():
    s = AgentSession(name="t", model="sonnet")
    absorb_repeat_card(s, p_card("That one failed."))
    s.messages.append(Message(role="user", content="try again", branch_id="main"))
    absorb_repeat_card(s, p_card("That one failed."))
    assert len([m for m in s.messages if m.role == "system"]) == 2


def test_different_error_text_always_appends():
    s = AgentSession(name="t", model="sonnet")
    absorb_repeat_card(s, p_card("Error A"))
    absorb_repeat_card(s, p_card("Error B"))
    assert len(s.messages) == 2


def test_other_branch_cards_do_not_mask():
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="system", content="Same text", branch_id="side"))
    absorb_repeat_card(s, p_card("Same text"))
    assert len(s.messages) == 2, "a card on another branch is invisible here and must not absorb"


def test_our_own_hidden_retries_do_not_earn_fresh_cards():
    """A live codex drill (2026-08-20) produced FIVE identical "still refreshing" cards on one ask.
    Each self-heal retry sends a HIDDEN user-role continuation, which displaced the previous card
    from the tail, so the dedup saw "a user message came in" and appended a clone. Our own
    machinery was manufacturing the wall it was written to prevent."""
    from backend.apps.agents.core.models import AgentSession, Message
    from backend.apps.agents.manager.run.handle_run_error import absorb_repeat_card

    s = AgentSession(name="t", model="gpt-5.6", dashboard_id="d")
    s.messages.append(Message(role="user", content="do the thing", branch_id=s.active_branch_id))
    card = "GPT subscription token is still refreshing."

    for _ in range(5):
        absorb_repeat_card(s, Message(role="system", content=card, branch_id=s.active_branch_id))
        # what every self-heal retry does next
        s.messages.append(Message(role="user", content="[Automated message] retry",
                                  branch_id=s.active_branch_id, hidden=True))

    shown = [m for m in s.messages if m.role == "system" and not m.hidden]
    assert len(shown) == 1, f"one honest card per ask, got {len(shown)}"


def test_a_real_user_message_still_earns_a_fresh_card():
    """Negative control: the rule only ignores OUR sends. A human asking again deserves its own
    answer, even if the answer is the same bad news."""
    from backend.apps.agents.core.models import AgentSession, Message
    from backend.apps.agents.manager.run.handle_run_error import absorb_repeat_card

    s = AgentSession(name="t", model="gpt-5.6", dashboard_id="d")
    card = "GPT subscription token is still refreshing."
    absorb_repeat_card(s, Message(role="system", content=card, branch_id=s.active_branch_id))
    s.messages.append(Message(role="user", content="try again please", branch_id=s.active_branch_id))
    absorb_repeat_card(s, Message(role="system", content=card, branch_id=s.active_branch_id))

    shown = [m for m in s.messages if m.role == "system"]
    assert len(shown) == 2, "each real ask gets its own honest answer"


def test_an_empty_thinking_pill_does_not_break_the_dedup():
    """Found by the live provider-error drill 2026-08-20, invisible to every unit test here.

    Each retry leaves a non-hidden `thinking` message with empty content sitting in the tail. It
    renders as nothing, but it displaced the previous card from the tail scan, so a re-failing
    ladder stacked three identical cards on screen while this suite stayed green.
    """
    s = AgentSession(name="t", model="sonnet")
    first = p_card("Lost the connection to the model.")
    absorb_repeat_card(s, first)
    s.messages.append(Message(role="thinking", content="", branch_id="main"))
    repeat = p_card("Lost the connection to the model.")
    absorb_repeat_card(s, repeat)
    p_cards = [m for m in s.messages if m.role == "system"]
    assert len(p_cards) == 1, "an invisible pill must not earn the user a duplicate card"
    assert repeat.id == first.id


def test_a_thinking_pill_with_real_content_still_breaks_the_dedup():
    """NEGATIVE CONTROL. Only the EMPTY pill is invisible; real thinking is content the user saw,
    so a card after it is genuinely new and must not be absorbed into the older one."""
    s = AgentSession(name="t", model="sonnet")
    first = p_card("Lost the connection to the model.")
    absorb_repeat_card(s, first)
    s.messages.append(Message(role="thinking", content="Let me try that again.", branch_id="main"))
    repeat = p_card("Lost the connection to the model.")
    absorb_repeat_card(s, repeat)
    p_cards = [m for m in s.messages if m.role == "system"]
    assert len(p_cards) == 2, "visible thinking separates the two failures"
