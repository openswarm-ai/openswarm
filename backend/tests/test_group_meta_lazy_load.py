"""generate-group-meta must find a chat that only lives on disk, the way GET /sessions/{id} does.

Seen in Eric's production console 2026-09-01: after a backend restart the renderer labelled a tool
group in an open chat, the route looked only in memory, `metadata.generate_group_meta` raised
ValueError, and the 500 surfaced as a CORS error (starlette's error middleware sits outside the CORS
middleware, so a raw 500 carries no CORS headers)."""
import asyncio
import pytest
from fastapi import HTTPException
import backend.apps.agents.agents as agents_mod


def p_run(coro):
    return asyncio.run(coro)


def test_a_chat_that_is_only_on_disk_is_loaded_then_labelled(monkeypatch) -> None:
    calls: list = []
    monkeypatch.setattr(agents_mod.agent_manager, "get_session", lambda sid: None)

    async def fake_resume(sid):
        calls.append(("resume", sid))
        return object()

    async def fake_generate(sid, group_id, tool_calls, results_summary=None, is_refinement=False):
        calls.append(("generate", sid, group_id))
        return {"name": "Reads", "icon": "<svg/>"}

    monkeypatch.setattr(agents_mod.agent_manager, "resume_session", fake_resume)
    monkeypatch.setattr(agents_mod.agent_manager, "generate_group_meta", fake_generate)
    out = p_run(agents_mod.generate_group_meta("abc123", {"group_id": "g1", "tool_calls": [{"tool": "Read"}]}))
    assert out["name"] == "Reads"
    assert calls == [("resume", "abc123"), ("generate", "abc123", "g1")]


def test_a_chat_that_exists_nowhere_is_an_honest_404_not_a_500(monkeypatch) -> None:
    monkeypatch.setattr(agents_mod.agent_manager, "get_session", lambda sid: None)

    async def fake_resume(sid):
        raise ValueError(f"Session {sid} not found")

    monkeypatch.setattr(agents_mod.agent_manager, "resume_session", fake_resume)
    with pytest.raises(HTTPException) as exc:
        p_run(agents_mod.generate_group_meta("nope", {"group_id": "g1", "tool_calls": [{"tool": "Read"}]}))
    assert exc.value.status_code == 404


def test_an_in_memory_chat_never_touches_the_disk(monkeypatch) -> None:
    monkeypatch.setattr(agents_mod.agent_manager, "get_session", lambda sid: object())

    async def fake_resume(sid):
        raise AssertionError("resume_session must not run for a chat already in memory")

    async def fake_generate(sid, group_id, tool_calls, results_summary=None, is_refinement=False):
        return {"name": "ok"}

    monkeypatch.setattr(agents_mod.agent_manager, "resume_session", fake_resume)
    monkeypatch.setattr(agents_mod.agent_manager, "generate_group_meta", fake_generate)
    assert p_run(agents_mod.generate_group_meta("mem", {"group_id": "g", "tool_calls": [{"tool": "Read"}]}))["name"] == "ok"
