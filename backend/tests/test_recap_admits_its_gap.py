"""A recap that hides its own gap turns lost context into a confident wrong answer.

Found on the packaged build 2026-08-29, simulating the heaviest real install's shape (123 tool calls,
132K input, serial read->run->read work). A proactive prune reclaimed ~40K, which is by design. Then
the chat was asked what the user's FIRST message had been, and it quoted a much later one as fact
instead of saying it did not know. Nothing in the recap distinguishes "this is the start of the
conversation" from "this is what survived the prune", so the model has no way to tell.

Row 5 on the ladder (a lying status), reached from row 1 (context silently gone). The loss itself is
the intended trade; presenting the remainder as the whole is not."""

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.session.history_compaction import build_history_prefix


def p_msgs():
    return [
        Message(role="user", content="Work in /tmp/osw-heavy, there are 14 modules", branch_id="main"),
        Message(role="tool_call", content={"tool": "Read", "input": {"file": "mod_01.py"}}, branch_id="main"),
        Message(role="tool_result", content={"tool_name": "Read", "text": "ok"}, branch_id="main"),
        Message(role="user", content="Now re-read them all", branch_id="main"),
        Message(role="tool_call", content={"tool": "Read", "input": {"file": "mod_02.py"}}, branch_id="main"),
        Message(role="tool_result", content={"tool_name": "Read", "text": "ok"}, branch_id="main"),
        Message(role="user", content="And once more", branch_id="main"),
    ]


def test_a_pruned_recap_says_it_does_not_start_at_the_beginning():
    msgs = p_msgs()
    out = build_history_prefix(msgs, cutoff_msg_id=msgs[2].id)
    low = out.lower()
    assert "dropped" in low, "the recap must admit earlier turns are gone"
    assert "does not begin at the start" in low or "not begin at the start" in low
    assert "say so rather than guessing" in low, "and tell it what to do instead of inventing one"


def test_an_UNPRUNED_recap_makes_no_such_claim():
    """The innocent case: a full recap really does start at the beginning, and telling the model
    otherwise would make it refuse to answer things it genuinely has."""
    out = build_history_prefix(p_msgs(), cutoff_msg_id=None)
    assert "dropped" not in out.lower()
    assert "The user asked:" in out, "a full recap still carries the asks"


def test_the_prune_is_counted_where_the_fleet_can_see_it():
    """ENG-418 added counters for the CLI's compactions and our mid-turn breaks. On a real heavy
    session BOTH read 0 while a proactive prune reclaimed ~40K, so the fleet still could not answer
    'how often does a chat lose history'."""
    s = AgentSession(name="t", model="opus-5")
    assert s.proactive_prunes == 0
    src = open("backend/apps/agents/manager/session/proactive_prune.py", encoding="utf-8").read()
    assert "session.proactive_prunes += 1" in src
    env = open("backend/apps/agents/manager/run/handle_run_error.py", encoding="utf-8").read()
    assert '"proactive_prunes"' in env, "counted but never sent is the same blind spot"
