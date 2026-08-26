"""A policy-block failover borrows the user's API key for ONE ask, then gives it back.

ENG-383 shipped `session.model = p_twin` as a PERMANENT rewrite with a single notice line. After
that one message, every later turn in the chat spent the user's metered Anthropic key and nothing
said so again: row 2 on the ladder, silent money spend. It is also the ENG-386 shape, a heal that
persists a model the user never chose.
"""

from backend.apps.agents.core.models import AgentSession

ERR = "backend/apps/agents/manager/run/handle_run_error.py"
MSG = "backend/apps/agents/manager/Messaging.py"


def p_session(**kw) -> AgentSession:
    return AgentSession(id="s1", name="chat", title="chat", **kw)


def test_the_session_remembers_the_lane_it_came_from():
    s = p_session(model="cc/claude-opus-5")
    assert s.lane_failover_from is None, "no borrow in progress by default"
    s.lane_failover_from = s.model
    s.model = "claude-opus-5-api"
    assert s.lane_failover_from == "cc/claude-opus-5"


def test_the_failover_records_where_to_go_back_to():
    src = open(ERR).read()
    i = src.index("session.model = p_twin")
    body = src[i:i + 200]
    assert "session.lane_failover_from = p_from" in body, \
        "a switch with no way back is a permanent spend"


def test_the_next_user_message_returns_the_session_to_its_own_lane():
    src = open(MSG).read()
    i = src.index("if session.lane_failover_from:")
    body = src[i:i + 400]
    assert "session.model = session.lane_failover_from" in body
    assert "session.lane_failover_from = None" in body, "the borrow must not be able to fire twice"
    # It has to sit inside the human-message branch, not fire on a hidden harness send, or the
    # continuation that the failover exists to run would be yanked back mid-ask.
    i_human = src.index("if not hidden:")
    i_reset = src.index("session.empty_finish_total = 0")
    assert i_human < i < i_reset + 600, "it must be part of the real-user-message reset block"


def test_the_notice_says_it_is_metered_and_temporary():
    import re
    src = open(ERR).read()
    i = src.index("Claude declined this request on your subscription")
    # Adjacent string literals are joined across source lines; read the sentence, not the layout.
    notice = re.sub(r'"\s*\n\s*"', "", src[i:i + 400])
    assert "billed to that key" in notice, "their own key costs them money; say so"
    assert "next message goes back on the subscription" in notice, "and say it is not permanent"


def test_a_hidden_continuation_cannot_end_the_borrow():
    # The continuation IS the ask the failover was for. If a hidden send restored the model, the
    # retry would go straight back to the lane that just refused it.
    src = open(MSG).read()
    i = src.index("if session.lane_failover_from:")
    guard = src.rindex("if not hidden:", 0, i)
    assert src.count("if not hidden:", guard, i) == 1
