import pytest
from backend.apps.agents.manager.session import history_compaction as hc
from backend.apps.agents.core.models import Message, MessageBranch, AgentSession


def make_msg(id, role, content, branch_id="main", hidden=False):
    return Message(id=id, role=role, content=content, branch_id=branch_id, hidden=hidden)


def test_branch_aware_compaction_replaces_low_importance_runs():
    # Build a session with many low-importance greetings, then a high-importance requirement
    msgs = []
    for i in range(1, 7):
        msgs.append(make_msg(f"g{i}", "user", "hi"))
        msgs.append(make_msg(f"a{i}", "assistant", "hello"))

    # Add a requirements message that must be preserved
    req = make_msg("req1", "user", "Requirement: must support feature X and Y.")
    msgs.append(req)

    sess = AgentSession(name="t", messages=msgs)
    sess.branches = {"main": MessageBranch(id="main", parent_branch_id=None, fork_point_message_id=None)}
    sess.active_branch_id = "main"

    # compact through the last assistant greeting (so many greets become candidates)
    sess.compacted_through_msg_id = "a6"

    out = hc._get_branch_messages(sess)

    # Ensure requirement message still present verbatim
    assert any(getattr(m, "content", None) and "Requirement" in str(m.content) for m in out)

    # Ensure at least one compressed summary message was inserted
    assert any(getattr(m, "content", None) and isinstance(m.content, str) and m.content.startswith("(compressed") for m in out)
