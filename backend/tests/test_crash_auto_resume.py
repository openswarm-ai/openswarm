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


def test_waiting_approval_never_auto_resumes(manager, tmp_path, monkeypatch):
    p_write_session(tmp_path, monkeypatch, "s-appr", "waiting_approval", [p_msg("user"), p_msg("tool_call")])
    asyncio.run(manager.reconcile_on_startup())
    assert manager.crash_resume_queue == []


def test_auto_resume_sends_one_hidden_continuation(manager, tmp_path, monkeypatch):
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
    assert prompt.startswith("[Automated message from OpenSwarm itself")
    assert manager.crash_resume_queue == []


def test_resume_failure_is_per_session_and_non_fatal(manager, tmp_path, monkeypatch):
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
