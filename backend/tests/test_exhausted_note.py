"""What the packaged drill caught that no unit test had: the honest "it stopped" line fired while a
recovery retry was already in flight, and it pointed at tool results that did not exist.

Split out of test_empty_finish.py because it is a different concern (what the user READS when the
machinery gives up) and because that file had reached its line ceiling.
"""

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.empty_finish import (
    EXHAUSTED_NOTE,
    EXHAUSTED_NOTE_NO_PROGRESS,
    NUDGE_PROMPT,
    surface_exhausted,
)

# --- found by the packaged drill, 2026-08-20 ------------------------------------------------------
#
# A Gemini 401 armed a silent auth retry, and the user was still told "the agent stopped working
# without a final report. Ask it to summarize, or check the tool results above" -- on a turn with
# ZERO tool results and a fix already in flight. Three defects in one card: it contradicted the
# retry, it pointed at work that did not exist, and it handed the user the job.

def test_a_recovery_retry_in_flight_is_not_announced_as_a_stop():
    from backend.apps.agents.manager.streaming.auth_retry import try_auth_self_heal
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="user", content="do the thing"))
    assert try_auth_self_heal(s) is True, "precondition: a retry really was armed"
    surface_exhausted(s, s.id)
    assert not [m for m in s.messages if m.role == "system"], \
        "a queued recovery retry means the turn is still going; do not claim it stopped"
    assert s.empty_finish_surfaced is False, \
        "the flag must stay unset so the honest line can still fire if the retry ends mute"


def test_the_nudge_ladder_still_reaches_its_own_ending():
    """NEGATIVE CONTROL. The ladder rides pending_continuation too, and its whole point is to end
    in this message, so a guard keyed on the flag alone would silently delete the ladder's ending."""
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="user", content="do the thing"))
    s.pending_continuation = True
    s.pending_continuation_prompt = NUDGE_PROMPT
    surface_exhausted(s, s.id)
    assert len([m for m in s.messages if m.role == "system"]) == 1, \
        "our own nudge must not be mistaken for a provider recovery"


def test_a_turn_with_no_work_is_not_told_to_check_work():
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="user", content="do the thing"))
    surface_exhausted(s, s.id)
    body = [m for m in s.messages if m.role == "system"][0].content
    assert body == EXHAUSTED_NOTE_NO_PROGRESS
    assert "above" not in body, "there is nothing above to point at"
    assert "summarize" not in body.lower(), "never hand the user the agent's job"


def test_a_turn_that_did_work_points_at_it():
    s = AgentSession(name="t", model="sonnet")
    s.messages.append(Message(role="user", content="do the thing"))
    s.messages.append(Message(role="tool_call", content={"tool": "Read"}))
    surface_exhausted(s, s.id)
    body = [m for m in s.messages if m.role == "system"][0].content
    assert body == EXHAUSTED_NOTE
    assert "summarize" not in body.lower(), "even with work, do not make the user extract it"
