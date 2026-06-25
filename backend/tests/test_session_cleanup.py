"""Invariant: closing or deleting a session must strand NO per-session state.

The orchestration core keeps several maps keyed by session id (the session
record, its asyncio task, the live partial-stream mirror, and two module-level
view-builder retry/dirty structures). Removal used to pop only `sessions` +
`tasks`, leaking the rest for the life of the process, an unbounded creep over
a long-running app. `purge_session_memory` is the single chokepoint both the
close and delete paths route through; this pins the invariant that after it
runs the id is gone from EVERY structure, while a sibling session is untouched.

Run with:  backend/.venv/bin/python -m pytest backend/tests/test_session_cleanup.py
"""
from backend.apps.agents import agent_manager as am
from backend.apps.agents.manager import view_builder_state as vbs


def test_purge_session_memory_clears_every_structure():
    mgr = am.AgentManager()
    mgr.sessions = {"dead": object(), "alive": object()}
    mgr.tasks = {"dead": object()}
    mgr.live_partial = {"dead": {"text": "half a reply"}}
    vbs.view_builder_render_retry_counts["dead"] = 4
    vbs.view_builder_dirty_sessions.add("dead")

    mgr.purge_session_memory("dead")

    assert "dead" not in mgr.sessions
    assert "dead" not in mgr.tasks
    assert "dead" not in mgr.live_partial
    assert "dead" not in vbs.view_builder_render_retry_counts
    assert "dead" not in vbs.view_builder_dirty_sessions
    # Only the target id is purged; an unrelated live session survives.
    assert "alive" in mgr.sessions


def test_purge_is_safe_on_an_untracked_id():
    # Purging an id that was never tracked must be a quiet no-op, not a KeyError, so the delete/close paths can call it unconditionally.
    mgr = am.AgentManager()
    mgr.purge_session_memory("never-existed")
    assert mgr.sessions == {}
