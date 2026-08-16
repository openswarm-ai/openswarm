"""A session reaches disk the moment a user message is appended (ENG-313).

Sessions used to persist only at turn END (and orderly close/shutdown), so a backend death mid-turn
destroyed the whole conversation if it was the first turn (404, zero bytes on disk, measured live on
packaged exp.8) and silently ate the turn's user message otherwise. The boot-side restore machinery
already handled files that exist; the write half was missing. These pin the write half.
"""
import os

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.session.session_store import load_session_data, snapshot_session_now


def p_make_session(sid: str) -> AgentSession:
    s = AgentSession(id=sid, name="snap-test", model="sonnet")
    s.status = "running"
    s.messages.append(Message(role="user", content="the message a crash must not eat", branch_id=s.active_branch_id))
    return s


def test_snapshot_writes_a_loadable_file_with_the_user_message(tmp_path, monkeypatch):
    import backend.apps.agents.agent_manager as am

    monkeypatch.setattr(am, "SESSIONS_DIR", str(tmp_path))
    s = p_make_session("snap-1")
    snapshot_session_now(s)
    data = load_session_data("snap-1")
    assert data is not None, "the whole bug: nothing on disk until turn end"
    assert data["messages"][0]["content"] == "the message a crash must not eat"
    assert data["status"] == "running"
    assert data["closed_at"] is None, "closed_at must stay unset or restore_all_sessions skips it"
    assert "search_text" in data, "history search must keep working on snapshotted sessions"


def test_restore_marks_a_snapshotted_midturn_session_resumable(tmp_path, monkeypatch):
    # The restore half already existed; this proves the two halves meet: a snapshot taken mid-turn
    # (user message, no assistant reply) restores as "stopped", which is the resumable state.
    import backend.apps.agents.agent_manager as am

    monkeypatch.setattr(am, "SESSIONS_DIR", str(tmp_path))
    s = p_make_session("snap-2")
    snapshot_session_now(s)
    data = load_session_data("snap-2")
    restored = AgentSession(**data)
    branch = restored.active_branch_id or "main"
    msgs = [m for m in restored.messages if (m.branch_id or "main") == branch]
    assert msgs and msgs[-1].role == "user"
    # Mirrors restore_all_sessions: last message is the user's -> agent was cut off owing a reply.
    expected = "completed" if msgs[-1].role == "assistant" else "stopped"
    assert expected == "stopped"


def test_a_snapshot_failure_never_breaks_the_send(tmp_path, monkeypatch):
    import backend.apps.agents.agent_manager as am

    monkeypatch.setattr(am, "SESSIONS_DIR", os.path.join(str(tmp_path), "no-such", "\0bad"))
    snapshot_session_now(p_make_session("snap-3"))  # must not raise


def test_every_user_message_append_site_snapshots():
    # The chokepoint audit: a new send path that forgets the snapshot reintroduces the bug for that
    # path only, which is exactly how the class comes back. Enumerate the sites.
    import backend.apps.agents.manager.AgentLaunch as launch
    import backend.apps.agents.manager.Messaging as messaging
    import backend.apps.agents.manager.SpawnAgentRun as spawn

    for mod, expected_appends in ((messaging, 2), (launch, 1), (spawn, 1)):
        src = open(mod.__file__).read()
        appends = src.count('.messages.append(user_msg)') + src.count('.messages.append(edited_msg)')
        snaps = src.count('snapshot_session_now(')
        assert appends == expected_appends, f"{mod.__name__}: append sites moved; re-audit this test"
        assert snaps >= appends, f"{mod.__name__}: {appends} user-append site(s) but only {snaps} snapshot(s)"
