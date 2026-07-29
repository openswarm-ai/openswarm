"""The universal event sources: the agent-check adapter's contract (verdict
parsing, baseline suppression, identical-event dedup) and the /api/events
ingest route (validation, idempotent dedup keys, dispatcher hand-off), plus
the guarantee that custom triggers are never polled.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_event_universal.py -v
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from backend.apps.events.models import AgentCheckSource, CustomEventSource, Event, EventTriggerConfig


def p_run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def p_events_env(isolated_workflows_data, reset_scheduler_state, monkeypatch, tmp_path):
    from backend.apps.events import dispatcher, poll_loop, stores

    monkeypatch.setattr(stores, "EVENTS_DIR", str(tmp_path / "events"))
    monkeypatch.setattr(stores, "CURSORS_DIR", str(tmp_path / "events" / "cursors"))
    monkeypatch.setattr(stores, "PENDING_DIR", str(tmp_path / "events" / "pending"))
    monkeypatch.setattr(stores, "LOGS_DIR", str(tmp_path / "events" / "logs"))
    dispatcher.stop()
    poll_loop.reset_state()
    yield
    dispatcher.stop()
    poll_loop.reset_state()


def test_parse_check_reply_contract():
    from backend.apps.events.adapters.agent_check import parse_check_reply

    event, state = parse_check_reply("I looked around.\nEVENT: A new episode dropped\nSTATE: latest is ep 42")
    assert event == "A new episode dropped"
    assert state == "latest is ep 42"

    event, state = parse_check_reply("Nothing changed.\nNO_EVENT\nSTATE: still ep 41")
    assert event is None
    assert state == "still ep 41"

    # Prose that echoes the format earlier can't fake a verdict; the LAST verdict wins.
    event, state = parse_check_reply("The format is EVENT: like this.\nNO_EVENT\nSTATE: s")
    assert event is None

    with pytest.raises(ValueError):
        parse_check_reply("I could not complete the check.")


def test_agent_check_baseline_then_event_then_dedup(monkeypatch):
    from backend.apps.events.adapters import agent_check as ac

    replies = iter([
        "EVENT: ignores the baseline rule\nSTATE: seen ep 41",  # model misbehaves on baseline
        "EVENT: Episode 42 is out\nSTATE: seen ep 42",
        "EVENT: Episode 42 is out\nSTATE: seen ep 42",  # same event re-reported
    ])
    prompts: list[str] = []

    async def p_fake_turn(model, prompt, dashboard_id=None, active_mcps=None, approvals=None):
        prompts.append(prompt)
        return next(replies)

    monkeypatch.setattr(ac, "run_check_turn", p_fake_turn)
    source = AgentCheckSource(check="a new episode of the show dropped", poll_seconds=60)

    events, cursor = p_run(ac.agent_check(source, {}))
    assert events == []  # baseline never fires, even when the model reports EVENT

    events, cursor = p_run(ac.agent_check(source, cursor))
    assert len(events) == 1
    assert events[0].summary == "Episode 42 is out"
    assert "seen ep 41" in prompts[1]  # previous state round-tripped into the prompt

    events, cursor = p_run(ac.agent_check(source, cursor))
    assert events == []  # identical event line reported again fires once, not forever


def test_agent_check_carries_workflow_context(make_wf, monkeypatch):
    """Pre-authorized MCPs, the workflow's remembered approvals, and the model
    all flow into the check turn; consent lives on the trigger config, never
    widened inside the session."""
    from backend.apps.events.adapters import agent_check as ac
    from backend.apps.workflows import executor

    seen: dict = {}

    async def p_fake_turn(model, prompt, dashboard_id=None, active_mcps=None, approvals=None):
        seen.update(model=model, dashboard_id=dashboard_id, active_mcps=active_mcps, approvals=approvals)
        return "NO_EVENT\nSTATE: s"

    monkeypatch.setattr(ac, "run_check_turn", p_fake_turn)
    monkeypatch.setattr(executor, "resolve_workflow_dashboard_id", lambda wf: "dash-42")

    source = AgentCheckSource(check="new invoice email arrived", mcps=["google-workspace"], poll_seconds=300)
    wf = make_wf(model="opus", remembered_approvals={"SendEmail": "deny"})
    p_run(ac.agent_check(source, {}, wf))

    assert seen["model"] == "opus"  # workflow's model, since the source didn't pin one
    assert seen["dashboard_id"] == "dash-42"
    assert seen["active_mcps"] == ["google-workspace"]
    assert seen["approvals"] == {"SendEmail": "deny"}


def p_custom_wf(make_wf):
    from backend.apps.workflows import storage

    trig = EventTriggerConfig(source=CustomEventSource(), coalesce_seconds=0)
    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)
    return wf, trig


def test_ingest_validates_and_dispatches(make_wf, monkeypatch):
    from backend.apps.events import dispatcher
    from backend.apps.events.events import IngestBody, ingest_event

    wf, trig = p_custom_wf(make_wf)
    delivered: list[Event] = []

    async def p_fake_ingest(workflow_id, trigger, events, persist=True):
        delivered.extend(events)

    monkeypatch.setattr(dispatcher, "ingest", p_fake_ingest)

    body = IngestBody(workflow_id=wf.id, trigger_id=trig.id, summary="Order #123 landed", dedup_key="order-123")
    res = p_run(ingest_event(body))
    assert res == {"ok": True, "queued": 1, "deduped": False}
    assert len(delivered) == 1
    assert delivered[0].source == "custom"

    # Same dedup_key again = idempotent, not a second run.
    res = p_run(ingest_event(body))
    assert res["deduped"] is True
    assert len(delivered) == 1

    with pytest.raises(HTTPException) as e:
        p_run(ingest_event(IngestBody(workflow_id="nope", trigger_id=trig.id, summary="x")))
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        p_run(ingest_event(IngestBody(workflow_id=wf.id, trigger_id="nope", summary="x")))
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        p_run(ingest_event(IngestBody(workflow_id=wf.id, trigger_id=trig.id, summary="   ")))
    assert e.value.status_code == 400


def test_ingest_refuses_non_custom_and_disabled(make_wf):
    from backend.apps.events.events import IngestBody, ingest_event
    from backend.apps.events.models import FileWatchSource
    from backend.apps.workflows import storage

    file_trig = EventTriggerConfig(source=FileWatchSource(path="/tmp/x"))
    off_trig = EventTriggerConfig(source=CustomEventSource(), enabled=False)
    wf = make_wf(event_triggers=[file_trig, off_trig])
    storage.save_workflow(wf)

    with pytest.raises(HTTPException) as e:
        p_run(ingest_event(IngestBody(workflow_id=wf.id, trigger_id=file_trig.id, summary="x")))
    assert e.value.status_code == 409
    with pytest.raises(HTTPException) as e:
        p_run(ingest_event(IngestBody(workflow_id=wf.id, trigger_id=off_trig.id, summary="x")))
    assert e.value.status_code == 409


def test_custom_triggers_are_never_polled(make_wf):
    from backend.apps.events import poll_loop, stores

    wf, trig = p_custom_wf(make_wf)

    async def scenario():
        poll_loop.tick()
        await asyncio.sleep(0.1)

    p_run(scenario())
    # No poll ran: no cursor written (beyond none), no log entries, no errors.
    assert stores.read_log(wf.id) == []
    assert stores.load_cursor(trig.id) == {}


def test_secret_url_ingest(make_wf, monkeypatch):
    """Paste-one-URL push: the path secret is the credential; wrong or short secrets 404."""
    from backend.apps.events import dispatcher
    from backend.apps.events.events import IngestPushBody, ingest_event_by_secret

    wf, trig = p_custom_wf(make_wf)
    delivered: list[Event] = []

    async def p_fake_ingest(workflow_id, trigger, events, persist=True):
        delivered.extend(events)

    monkeypatch.setattr(dispatcher, "ingest", p_fake_ingest)
    secret = trig.source.secret
    res = p_run(ingest_event_by_secret(secret, IngestPushBody(summary="Order landed", dedup_key="o1")))
    assert res == {"ok": True, "queued": 1, "deduped": False}
    assert len(delivered) == 1

    with pytest.raises(HTTPException) as e:
        p_run(ingest_event_by_secret("f" * 32, IngestPushBody(summary="x")))
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        p_run(ingest_event_by_secret("short", IngestPushBody(summary="x")))
    assert e.value.status_code == 404


def test_mcp_auto_suggest_and_signature_vector(monkeypatch):
    import backend.apps.agents.schedule_mcp_server as srv

    known = {"google-workspace", "notion"}
    assert srv.suggest_mcps("a new email from my landlord arrived", known) == ["google-workspace"]
    assert srv.suggest_mcps("my notion database gained a row", known) == ["notion"]
    assert srv.suggest_mcps("the moon is full", known) == []
    # Byte-match the FE stepsSignature: JSON.stringify([["s1","a\"b"]]).
    assert srv.steps_signature([{"id": "s1", "text": 'a"b'}]) == '[["s1","a\\"b"]]'
