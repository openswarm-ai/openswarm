"""The floor: a finished turn always left the user something to read.

Every earlier silent-stop fix was a detector for one shape found in the field, which means the
NEXT shape nobody has found yet still ships as silence. This asks the user's own question at the
one exit every terminal path passes through, so the state stops being representable rather than
being enumerated.
"""

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.empty_finish import EXHAUSTED_NOTE
from backend.apps.agents.manager.run.turn_spoke import ensure_turn_spoke, turn_left_the_user_with_nothing


def p_session(*msgs, status="completed") -> AgentSession:
    s = AgentSession(name="t", model="sonnet", dashboard_id="d")
    s.status = status
    for role, content in msgs:
        s.messages.append(Message(role=role, content=content, branch_id=s.active_branch_id))
    return s


def p_cards(s):
    return [m for m in s.messages if m.role == "system"]


def test_a_shape_no_detector_knows_about_still_gets_a_line():
    """The whole point: this must fire for causes nobody has enumerated. Here the turn ended with
    only a tool call, which no existing detector claimed."""
    s = p_session(("user", "audit the repo"), ("tool_call", {"tool": "Bash"}))
    assert turn_left_the_user_with_nothing(s) is True
    assert ensure_turn_spoke(s, "sid") is True
    assert [m.content for m in p_cards(s)] == [EXHAUSTED_NOTE]


def test_it_never_speaks_over_a_turn_that_answered():
    s = p_session(("user", "hi"), ("assistant", "here is your answer"))
    assert ensure_turn_spoke(s, "sid") is False
    assert p_cards(s) == []


def test_it_never_doubles_up_on_a_detector_that_already_spoke():
    """Upstream detectors write BETTER messages because they know why; the floor must stay quiet
    whenever one of them already did the job."""
    s = p_session(("user", "go"), ("tool_call", {"tool": "Read"}),
                  ("system", "Your ChatGPT subscription needs reconnecting."))
    assert ensure_turn_spoke(s, "sid") is False
    assert len(p_cards(s)) == 1


def test_a_rendered_widget_counts_as_an_answer():
    s = p_session(("user", "pick one"), ("tool_call", {"tool": "mcp__openswarm-ui__AskUI"}))
    assert ensure_turn_spoke(s, "sid") is False


def test_a_still_running_turn_is_left_alone():
    s = p_session(("user", "go"), ("tool_call", {"tool": "Read"}), status="running")
    assert ensure_turn_spoke(s, "sid") is False


def test_a_parked_turn_is_not_over_so_it_stays_quiet():
    """Speaking over a turn that is about to resume would be the lie this exists to prevent."""
    s = p_session(("user", "go"), ("tool_call", {"tool": "Read"}))
    s.awaiting_reconnect = True
    assert ensure_turn_spoke(s, "sid") is False
    s.awaiting_reconnect = False
    s.pending_continuation = True
    assert ensure_turn_spoke(s, "sid") is False


def test_a_user_stop_needs_no_explanation():
    """They pressed stop; telling them it stopped is noise, not honesty."""
    s = p_session(("user", "go"), ("tool_call", {"tool": "Read"}), status="stopped")
    assert ensure_turn_spoke(s, "sid") is False


def test_only_work_since_the_LAST_ask_counts():
    """A reply to the previous question must not excuse silence on the current one."""
    s = p_session(("user", "first"), ("assistant", "answered the first"),
                  ("user", "second"), ("tool_call", {"tool": "Read"}))
    assert turn_left_the_user_with_nothing(s) is True


def test_hidden_machinery_is_invisible_to_the_check():
    """Our own hidden continuations are not the user speaking, and not us answering."""
    s = AgentSession(name="t", model="sonnet", dashboard_id="d")
    s.status = "completed"
    s.messages.append(Message(role="user", content="go", branch_id=s.active_branch_id))
    s.messages.append(Message(role="tool_call", content={"tool": "Read"}, branch_id=s.active_branch_id))
    s.messages.append(Message(role="user", content="[Automated] continue",
                              branch_id=s.active_branch_id, hidden=True))
    assert turn_left_the_user_with_nothing(s) is True
