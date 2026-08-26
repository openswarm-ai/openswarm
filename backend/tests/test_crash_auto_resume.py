"""Pins the crash auto-resume contract (the last silent-stop door): a turn cut off by a dirty
death resumes itself exactly once; consecutive crash implications trip the breaker to the manual
chip (hermes #30719 pairing); a clean quit or a finished stream never auto-resumes; and a real
user message forgives the crash history."""

import asyncio
import json
import os

import pytest

from backend.apps.agents import agent_manager as p_am_module


def p_write_session(tmp_path, monkeypatch, sid: str, status: str, msgs, count: int = 0):
    data = {
        "id": sid, "name": "t", "status": status, "provider": "anthropic", "model": "sonnet",
        "mode": "agent", "messages": msgs, "active_branch_id": "main",
        "crash_interrupt_count": count, "closed_at": None,
    }
    path = os.path.join(str(tmp_path), f"{sid}.json")
    with open(path, "w") as f:
        json.dump(data, f)
    return data


def p_msg(role, text="x"):
    return {"role": role, "content": text, "branch_id": "main", "id": f"m-{role}-{text[:6]}"}


@pytest.fixture()
def manager(tmp_path, monkeypatch):
    monkeypatch.setattr(p_am_module, "SESSIONS_DIR", str(tmp_path))
    mgr = p_am_module.AgentManager()
    return mgr


def test_crash_cut_turn_queues_for_auto_resume(manager, tmp_path, monkeypatch):
    p_write_session(tmp_path, monkeypatch, "s-cut", "running", [p_msg("user", "do work"), p_msg("tool_call")])
    asyncio.run(manager.reconcile_on_startup())
    assert manager.crash_resume_queue == ["s-cut"]
    with open(os.path.join(str(tmp_path), "s-cut.json")) as f:
        assert json.load(f)["crash_interrupt_count"] == 1


def test_finished_stream_and_clean_quit_never_queue(manager, tmp_path, monkeypatch):
    p_write_session(tmp_path, monkeypatch, "s-done", "running", [p_msg("user"), p_msg("assistant", "answer")])
    p_write_session(tmp_path, monkeypatch, "s-clean", "stopped", [p_msg("user"), p_msg("tool_call")])
    asyncio.run(manager.reconcile_on_startup())
    assert manager.crash_resume_queue == []


def test_second_consecutive_crash_trips_the_breaker(manager, tmp_path, monkeypatch):
    p_write_session(tmp_path, monkeypatch, "s-loop", "running", [p_msg("user"), p_msg("tool_call")], count=1)
    asyncio.run(manager.reconcile_on_startup())
    assert manager.crash_resume_queue == [], "a session mid-turn at 2 consecutive dirty deaths must NOT auto-resume"
    with open(os.path.join(str(tmp_path), "s-loop.json")) as f:
        assert json.load(f)["crash_interrupt_count"] == 2


def p_act_like_a_real_app(monkeypatch) -> None:
    """Auto-resume refuses to dispatch under pytest, because it sends REAL turns and the suite shares
    the developer's data root (ENG-388). These tests are about the production path, so they opt out."""
    import backend.apps.agents.manager.session.SessionPersistence as p_sp
    monkeypatch.setattr(p_sp, "auto_resume_held_because", lambda: None)


def test_waiting_approval_never_auto_resumes(manager, tmp_path, monkeypatch):
    p_write_session(tmp_path, monkeypatch, "s-appr", "waiting_approval", [p_msg("user"), p_msg("tool_call")])
    asyncio.run(manager.reconcile_on_startup())
    assert manager.crash_resume_queue == []


def test_auto_resume_sends_one_hidden_continuation(manager, tmp_path, monkeypatch):
    p_act_like_a_real_app(monkeypatch)
    p_write_session(tmp_path, monkeypatch, "s-cut", "running", [p_msg("user"), p_msg("tool_call")])
    asyncio.run(manager.reconcile_on_startup())
    sent = []

    async def p_fake_send(sid, prompt, **kw):
        sent.append((sid, prompt, kw.get("hidden")))
    monkeypatch.setattr(manager, "send_message", p_fake_send)
    asyncio.run(manager.auto_resume_crashed_turns())
    assert len(sent) == 1
    sid, prompt, hidden = sent[0]
    assert sid == "s-cut" and hidden is True
    assert "restarted while you were mid-task" in prompt, "the attribution prefix is added once, at the send chokepoint"
    assert manager.crash_resume_queue == []


def test_resume_failure_is_per_session_and_non_fatal(manager, tmp_path, monkeypatch):
    p_act_like_a_real_app(monkeypatch)
    p_write_session(tmp_path, monkeypatch, "s-a", "running", [p_msg("user"), p_msg("tool_call")])
    p_write_session(tmp_path, monkeypatch, "s-b", "running", [p_msg("user"), p_msg("tool_call")])
    asyncio.run(manager.reconcile_on_startup())
    sent = []

    async def p_flaky_send(sid, prompt, **kw):
        if sid == sorted(["s-a", "s-b"])[0]:
            raise RuntimeError("boom")
        sent.append(sid)
    monkeypatch.setattr(manager, "send_message", p_flaky_send)
    asyncio.run(manager.auto_resume_crashed_turns())
    assert len(sent) == 1


def test_a_terminal_system_card_tail_is_not_owed(manager, tmp_path, monkeypatch):
    """ENG-366: an overflow card, an exhausted note or a notice is the END of that ask; a dirty death
    after it must not poke a finished chat back to life with a hidden continue."""
    p_write_session(tmp_path, monkeypatch, "s-card", "running",
                    [p_msg("user", "do work"), p_msg("tool_call"), p_msg("system", "This chat exceeded the model's context window")])
    asyncio.run(manager.reconcile_on_startup())
    assert manager.crash_resume_queue == []


def test_a_system_notice_with_an_armed_continuation_is_owed(manager, tmp_path, monkeypatch):
    data = p_write_session(tmp_path, monkeypatch, "s-wait", "running",
                           [p_msg("user", "do work"), p_msg("system", "token rotated, retrying in a minute")])
    data["pending_continuation"] = True
    with open(os.path.join(str(tmp_path), "s-wait.json"), "w") as f:
        json.dump(data, f)
    asyncio.run(manager.reconcile_on_startup())
    assert manager.crash_resume_queue == ["s-wait"]
