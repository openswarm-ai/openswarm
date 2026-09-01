"""The nudge ladder's give-up note must not send a working chat after the wrong remedy.

There were two notes: "work is above, carry on" when the turn produced something, and "could not get
started... switch this agent to another model" when it did not. The second is right for a chat that
truly never started, and wrong for a chat that has done a pile of work and stalled on one turn: the
user can see their own transcript, and switching models drags the same conversation into the same
stall. Third case added 2026-09-01 after a real LinkedIn run ended on the model-blaming note.
"""
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.empty_finish import (
    EXHAUSTED_NOTE, EXHAUSTED_NOTE_LONG_CHAT, EXHAUSTED_NOTE_NO_PROGRESS,
    session_showed_work, turn_showed_work,
)


def p_session():
    s = AgentSession(name="t", model="sonnet-5", dashboard_id="d")
    return s, s.active_branch_id


def test_a_chat_that_never_started_still_gets_the_original_advice():
    s, b = p_session()
    s.messages.append(Message(role="user", content="do the thing", branch_id=b))
    assert turn_showed_work(s) is False
    assert session_showed_work(s) is False, "nothing has ever run; switching models is fair advice"
    assert "switch this agent to another model" in EXHAUSTED_NOTE_NO_PROGRESS


def test_a_chat_with_work_behind_it_is_not_told_it_never_started():
    s, b = p_session()
    s.messages.append(Message(role="user", content="find people to connect with", branch_id=b))
    s.messages.append(Message(role="tool_call", content={"id": "t1", "tool": "BrowserAgent", "input": {}}, branch_id=b))
    s.messages.append(Message(role="tool_result", content={"tool_use_id": "t1", "text": "ok"}, branch_id=b))
    s.messages.append(Message(role="user", content="keep going", branch_id=b))
    assert turn_showed_work(s) is False, "nothing since the LAST user message"
    assert session_showed_work(s) is True, "but the chat plainly did work"


def test_the_long_chat_note_rules_out_the_wrong_remedy_and_names_the_right_one():
    low = EXHAUSTED_NOTE_LONG_CHAT.lower()
    assert "switching models will not help" in low
    assert "fresh chat" in low
    assert "could not get started" not in low, "false to anyone reading their own transcript"


def test_the_three_notes_are_distinct():
    assert len({EXHAUSTED_NOTE, EXHAUSTED_NOTE_LONG_CHAT, EXHAUSTED_NOTE_NO_PROGRESS}) == 3


def test_the_selector_prefers_turn_work_then_session_work():
    """Ordering: a turn that produced work must still get the 'work is above' note."""
    import inspect
    from backend.apps.agents.manager.run import empty_finish as mod
    src = inspect.getsource(mod.surface_exhausted)
    assert src.index("turn_showed_work(session)") < src.index("session_showed_work(session)")
