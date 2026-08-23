"""A test run must never become an agent run.

The bug class (caught live 2026-08-21): `agents_lifespan` fires `auto_resume_crashed_turns()`, which
sends a real hidden continuation into every crash-interrupted session. The suite does not isolate the
data root, so any test that boots the app lifespan resumed the DEVELOPER'S OWN chats with live
credentials and live Bash, inside whatever tree the suite was running from. Observed: a full
`pytest backend/tests` run spawned two real CLI processes which each started their own
`pytest backend/tests/` run, because that was the task those chats had been interrupted mid-way
through. It spends real money, rewrites real session files, and executes commands from old
conversations against the working tree.

The seal: auto-resume refuses to dispatch when pytest is loaded.
"""

import asyncio

import backend.apps.agents.manager.session.SessionPersistence as p_sp
from backend.apps.agents.agent_manager import agent_manager


def p_capture_sends(monkeypatch) -> list:
    sent: list = []

    async def fake_send(session_id, prompt, hidden=False, **kwargs):
        sent.append(session_id)

    monkeypatch.setattr(agent_manager, "send_message", fake_send)
    agent_manager.crash_resume_queue = ["sid-a", "sid-b"]
    return sent


def test_auto_resume_never_dispatches_under_test(monkeypatch):
    sent = p_capture_sends(monkeypatch)
    asyncio.run(agent_manager.auto_resume_crashed_turns())
    assert sent == [], "a suite run must not spend credentials resuming real chats"
    assert agent_manager.crash_resume_queue == [], "the queue is still cleared, so nothing resumes later either"


def test_the_gate_is_what_stops_it(monkeypatch):
    """Control: with the gate reporting a normal app process, the very same call does dispatch.
    Without this arm the test above passes even if auto-resume quietly stopped working."""
    sent = p_capture_sends(monkeypatch)
    monkeypatch.setattr(p_sp, "running_under_test", lambda: False)
    asyncio.run(agent_manager.auto_resume_crashed_turns())
    assert sent == ["sid-a", "sid-b"]


def test_the_gate_sees_pytest():
    assert p_sp.running_under_test() is True


def test_the_declared_signal_works_without_the_accidental_one(monkeypatch):
    """The env var must stand on its own: the day `pytest in sys.modules` stops being true in some
    runner, the gate has to keep holding, or crash-resume silently reactivates against real chats."""
    monkeypatch.setenv("OSW_DISABLE_AUTO_RESUME", "1")
    monkeypatch.setitem(__import__("sys").modules, "pytest", None)
    assert p_sp.running_under_test() is True
