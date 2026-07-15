"""Distilled-history summary invariant.

On a rebuild the recap hard-drops everything before the cutoff, losing the thread of a
long chat. distilled_history_summary replaces that void with a cached aux-LLM summary of
the dropped span. These pin: it summarizes the dropped span, caches against the cutoff id,
recomputes when the cutoff advances, and fails open (no provider / kill switch / aux error
-> "", so the caller keeps today's hard-drop).
"""

import asyncio

import backend.apps.agents.manager.session.distill_history as dh
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.settings.settings import load_settings


def p_session(n: int) -> AgentSession:
    s = AgentSession(name="t", model="sonnet")
    s.messages = [Message(role="user", content=f"turn {i}") for i in range(n)]
    return s


def p_stub_distiller(monkeypatch, calls: list) -> None:
    async def fake(session, settings, body):
        calls.append(body)
        return f"SUMMARY[{len(body)} chars]"
    monkeypatch.setattr(dh, "p_call_distiller", fake)


def test_no_cutoff_returns_empty(monkeypatch) -> None:
    calls: list = []
    p_stub_distiller(monkeypatch, calls)
    s = p_session(8)
    out = asyncio.run(dh.distilled_history_summary(s, load_settings()))
    assert out == ""
    assert calls == []


def test_summarizes_dropped_span_and_caches(monkeypatch) -> None:
    calls: list = []
    p_stub_distiller(monkeypatch, calls)
    s = p_session(8)
    s.compacted_through_msg_id = s.messages[3].id  # drop turns 0..3
    out = asyncio.run(dh.distilled_history_summary(s, load_settings()))
    assert out.startswith("SUMMARY[")
    assert s.compacted_summary == out
    assert s.compacted_summary_through == s.messages[3].id
    assert "turn 0" in calls[0] and "turn 3" in calls[0]
    assert "turn 4" not in calls[0]  # surviving turns aren't distilled
    # Second call at the same cutoff reuses the cache, no new aux call.
    again = asyncio.run(dh.distilled_history_summary(s, load_settings()))
    assert again == out
    assert len(calls) == 1


def test_recomputes_when_cutoff_advances(monkeypatch) -> None:
    calls: list = []
    p_stub_distiller(monkeypatch, calls)
    s = p_session(10)
    s.compacted_through_msg_id = s.messages[3].id
    asyncio.run(dh.distilled_history_summary(s, load_settings()))
    s.compacted_through_msg_id = s.messages[6].id  # cutoff moved forward
    asyncio.run(dh.distilled_history_summary(s, load_settings()))
    assert len(calls) == 2
    assert "turn 6" in calls[1]


def test_fail_open_on_aux_error(monkeypatch) -> None:
    async def boom(session, settings, body):
        raise RuntimeError("provider down")
    monkeypatch.setattr(dh, "p_call_distiller", boom)
    s = p_session(8)
    s.compacted_through_msg_id = s.messages[3].id
    out = asyncio.run(dh.distilled_history_summary(s, load_settings()))
    assert out == ""
    assert s.compacted_summary is None


def test_stale_cache_not_served_when_cutoff_left_the_branch(monkeypatch) -> None:
    calls: list = []
    p_stub_distiller(monkeypatch, calls)
    s = p_session(8)
    s.compacted_through_msg_id = s.messages[3].id
    asyncio.run(dh.distilled_history_summary(s, load_settings()))  # caches
    assert s.compacted_summary is not None
    # Simulate a branch edit that dropped the cutoff message from the active branch.
    s.messages = [m for m in s.messages if m.id != s.messages[3].id]
    out = asyncio.run(dh.distilled_history_summary(s, load_settings()))
    assert out == ""  # membership check fires before the cache, so the stale summary is not served


def test_kill_switch_disables(monkeypatch) -> None:
    calls: list = []
    p_stub_distiller(monkeypatch, calls)
    monkeypatch.setattr(dh, "DISTILL_ENABLED", False)
    s = p_session(8)
    s.compacted_through_msg_id = s.messages[3].id
    out = asyncio.run(dh.distilled_history_summary(s, load_settings()))
    assert out == ""
    assert calls == []
