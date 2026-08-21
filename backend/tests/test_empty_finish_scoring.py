"""ENG-364 pins: a structured final answer is an answer, and a real user message forgives the
session's silent-quit history (the repeat floor and the vanishing-quit rule key on it)."""

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.empty_finish import turn_finished_empty


def p_session(*msgs) -> AgentSession:
    s = AgentSession(name="t", model="sonnet")
    for role, content in msgs:
        s.messages.append(Message(role=role, content=content, branch_id="main"))
    return s


def test_structured_assistant_content_is_not_a_silent_quit():
    """ENG-364: a final answer written as content blocks used to score as "", i.e. as a quit."""
    s = p_session(("user", "audit"),
                  ("tool_call", {"tool": "Bash", "input": {}}),
                  ("tool_result", {"text": "ok"}),
                  ("assistant", [{"type": "text", "text": "Done: 3 findings."}]))
    assert turn_finished_empty(s) is False
    s2 = p_session(("user", "audit"),
                   ("tool_call", {"tool": "Bash", "input": {}}),
                   ("tool_result", {"text": "ok"}),
                   ("assistant", [{"type": "text", "text": "   "}]))
    assert turn_finished_empty(s2) is True


def test_a_real_user_message_forgives_the_quit_history():
    """ENG-364: empty_finish_total drives the 40% repeat floor and the vanishing-quit rule; it must
    reset with the rest of the per-ask budget or one false positive arms both forever."""
    import inspect
    from backend.apps.agents.manager import Messaging
    src = inspect.getsource(Messaging)
    block = src.split("session.empty_finish_nudges = 0", 1)[1].split("if not hidden and prompt", 1)[0]
    assert "session.empty_finish_total = 0" in block
