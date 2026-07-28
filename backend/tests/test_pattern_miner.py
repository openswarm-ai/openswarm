"""Pattern-miner invariants: evidence gathering excludes what must never count
(sub-agents, workflow runs, already-automated titles, stale/empty sessions),
cadence + counts are computed in code from verified evidence (never the aux
model's claims), dismissed patterns stay dismissed, the kill switch gates the
miner itself, and accept creates a real scheduled workflow.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_pattern_miner.py -v
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest


def p_run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def p_patterns_env(isolated_workflows_data, reset_scheduler_state, monkeypatch, tmp_path):
    from backend.apps.agents import agent_manager as p_am
    from backend.apps.patterns import store as p_store
    from backend.apps.settings import settings as p_settings

    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    monkeypatch.setattr(p_am, "SESSIONS_DIR", str(sessions_dir))
    monkeypatch.setattr(p_store, "PATTERNS_DIR", str(tmp_path / "patterns"))
    monkeypatch.setattr(p_store, "SUGGESTIONS_FILE", str(tmp_path / "patterns" / "suggestions.json"))
    monkeypatch.setattr(p_store, "STATE_FILE", str(tmp_path / "patterns" / "state.json"))
    monkeypatch.setattr(p_settings, "load_settings", lambda: SimpleNamespace(pattern_suggestions_enabled=True))
    yield sessions_dir


def p_write_session(sessions_dir, session_id: str, created_at: datetime, name: str = "Inbox check",
                    first_msg: str = "summarize my inbox", **extra) -> str:
    doc = {
        "name": name,
        "created_at": created_at.isoformat(),
        "messages": [{"role": "user", "content": first_msg}] if first_msg else [],
        "browser_domains": extra.pop("browser_domains", []),
    }
    doc.update(extra)
    (sessions_dir / f"{session_id}.json").write_text(json.dumps(doc))
    return session_id


def p_pattern_times(n: int = 4) -> list[datetime]:
    # Same weekday + hour, spread over n weeks, all safely in the past.
    return [datetime.now() - timedelta(days=7 * k, hours=1) for k in range(n)]


def test_gather_excludes_what_must_never_count(p_patterns_env):
    from backend.apps.patterns.miner import gather_evidence

    now = datetime.now()
    p_write_session(p_patterns_env, "keepme", now - timedelta(days=1))
    p_write_session(p_patterns_env, "subagent", now - timedelta(days=1), parent_session_id="parent1")
    p_write_session(p_patterns_env, "wfrun", now - timedelta(days=1), workflow_run_id="run1")
    p_write_session(p_patterns_env, "stale", now - timedelta(days=45))
    p_write_session(p_patterns_env, "automated", now - timedelta(days=1), name="Morning brief")
    p_write_session(p_patterns_env, "nomsg", now - timedelta(days=1), first_msg="")

    evidence = gather_evidence(automated_titles=["Morning brief"])
    assert [e.id for e in evidence] == ["keepme"]


def test_cadence_computed_in_code():
    from backend.apps.patterns.miner import compute_cadence

    weekly_times = p_pattern_times(4)
    cadence = compute_cadence(weekly_times)
    assert cadence.kind == "weekly"
    assert cadence.on_days == [(weekly_times[0].weekday() + 1) % 7]
    assert cadence.hour == weekly_times[0].hour

    daily_times = [datetime(2026, 7, d, 9, 0) for d in range(10, 16)]
    assert compute_cadence(daily_times).kind == "daily"

    scattered = [datetime(2026, 7, 6, 9), datetime(2026, 7, 14, 15), datetime(2026, 7, 22, 20)]
    assert compute_cadence(scattered).kind == "irregular"


def test_parse_drops_fabricated_evidence():
    from backend.apps.patterns.miner import SessionEvidence, parse_suggestions

    by_id = {
        f"s{i}": SessionEvidence(id=f"s{i}", created_at=datetime.now() - timedelta(days=i),
                                 title="t", first_message="m", domains=[])
        for i in range(4)
    }
    raw = json.dumps([
        {  # only 2 of its claimed ids exist -> dropped despite claiming 4
            "description": "You often do a fabricated thing",
            "session_ids": ["s0", "s1", "ghost1", "ghost2"],
            "workflow_title": "Fabricated thing",
            "workflow_steps": ["do it"],
        },
        {
            "description": "You often summarize your inbox in the morning",
            "session_ids": ["s0", "s1", "s2", "s3"],
            "workflow_title": "Morning inbox summary",
            "workflow_steps": ["Summarize the inbox"],
        },
    ])
    out = parse_suggestions(raw, by_id)
    assert len(out) == 1
    assert out[0].evidence_count == 4  # our count from verified ids, not the model's
    assert out[0].workflow_title == "Morning inbox summary"

    assert parse_suggestions("total garbage", by_id) == []
    assert parse_suggestions("```json\n[]\n```", by_id) == []


def p_seed_pattern(sessions_dir) -> list[str]:
    ids = []
    for i, t in enumerate(p_pattern_times(4)):
        ids.append(p_write_session(sessions_dir, f"pat{i}", t, name="AI news rundown",
                                   first_msg="give me a rundown of today's AI news"))
    # Filler so MIN_SESSIONS_TO_MINE is met.
    for i in range(8):
        p_write_session(sessions_dir, f"fill{i}", datetime.now() - timedelta(days=i + 1, hours=3),
                        name=f"One-off {i}", first_msg=f"random question {i}")
    return ids


def p_miner_json(ids: list[str]) -> str:
    return json.dumps([{
        "description": "You often ask for a rundown of AI news",
        "session_ids": ids,
        "workflow_title": "Daily AI news rundown",
        "workflow_steps": ["Gather today's AI news and summarize the top stories"],
    }])


def test_mining_pass_end_to_end(p_patterns_env, monkeypatch):
    from backend.apps.patterns import miner, store

    ids = p_seed_pattern(p_patterns_env)

    async def p_fake_aux(lines, automated_titles, declined):
        return p_miner_json(ids)

    monkeypatch.setattr(miner, "p_call_miner", p_fake_aux)
    assert p_run(miner.run_mining_pass(force=True)) == 1
    pending = store.pending_suggestions()
    assert len(pending) == 1
    assert pending[0].evidence_count == 4
    assert pending[0].cadence.kind == "weekly"

    # A near-identical pattern is never offered twice.
    assert p_run(miner.run_mining_pass(force=True)) == 0

    # The daily throttle blocks an unforced pass outright.
    assert p_run(miner.run_mining_pass(force=False)) == 0


def test_dismissed_signature_never_returns(p_patterns_env, monkeypatch):
    from backend.apps.patterns import miner, store

    ids = p_seed_pattern(p_patterns_env)

    async def p_fake_aux(lines, automated_titles, declined):
        return p_miner_json(ids)

    monkeypatch.setattr(miner, "p_call_miner", p_fake_aux)
    p_run(miner.run_mining_pass(force=True))
    suggestion = store.pending_suggestions()[0]
    suggestion.status = "dismissed"
    store.update_suggestion(suggestion)

    assert p_run(miner.run_mining_pass(force=True)) == 0
    assert store.pending_suggestions() == []


def test_kill_switch_gates_the_miner_itself(p_patterns_env, monkeypatch):
    from backend.apps.patterns import miner
    from backend.apps.settings import settings as p_settings

    p_seed_pattern(p_patterns_env)
    monkeypatch.setattr(p_settings, "load_settings", lambda: SimpleNamespace(pattern_suggestions_enabled=False))

    async def p_fail_if_called(lines, automated_titles, declined):
        raise AssertionError("miner ran despite kill switch")

    monkeypatch.setattr(miner, "p_call_miner", p_fail_if_called)
    assert p_run(miner.run_mining_pass(force=True)) == 0


def test_accept_creates_real_scheduled_workflow(p_patterns_env, monkeypatch):
    from backend.apps.agents.core.ws_manager import ws_manager
    from backend.apps.patterns import miner, store
    from backend.apps.patterns.patterns import accept_suggestion, dismiss_suggestion
    from backend.apps.workflows import storage as wf_storage
    from backend.apps.workflows import workflows as wf_routes

    async def p_noop(*args, **kwargs):
        return None

    monkeypatch.setattr(ws_manager, "broadcast_global", p_noop)

    async def p_no_meta(wf):
        return "", "", []

    monkeypatch.setattr(wf_routes, "_generate_workflow_metadata", p_no_meta)

    ids = p_seed_pattern(p_patterns_env)

    async def p_fake_aux(lines, automated_titles, declined):
        return p_miner_json(ids)

    monkeypatch.setattr(miner, "p_call_miner", p_fake_aux)
    p_run(miner.run_mining_pass(force=True))
    suggestion = store.pending_suggestions()[0]

    result = p_run(accept_suggestion(suggestion.id))
    wf = wf_storage.get_workflow(result["workflow"]["id"])
    assert wf is not None
    assert wf.title == "Daily AI news rundown"
    assert wf.schedule.enabled is True
    assert wf.schedule.repeat_unit == "week"
    assert wf.steps[0].text.startswith("Gather today's AI news")
    assert store.get_suggestion(suggestion.id).status == "accepted"
    assert store.get_suggestion(suggestion.id).workflow_id == wf.id

    # Accepted or dismissed suggestions can't be acted on twice.
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        p_run(dismiss_suggestion(suggestion.id))
