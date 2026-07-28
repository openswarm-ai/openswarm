"""Dispatcher + poll-loop coordination rules: one run per burst, nothing fires
for a removed/disabled/rate-capped trigger, a busy workflow requeues instead
of dropping, the predicate gates fires (and its unavailability skips, never
spams), pending events survive a restart, and pause-all holds fires.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_event_dispatcher.py -v
"""

from __future__ import annotations

import asyncio

import pytest

from backend.apps.events.models import Event, EventTriggerConfig, FileWatchSource


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


def p_file_trigger(**overrides) -> EventTriggerConfig:
    base = dict(source=FileWatchSource(path="/tmp/nowhere"), coalesce_seconds=0)
    base.update(overrides)
    return EventTriggerConfig(**base)


def p_events(n: int) -> list[Event]:
    return [
        Event(source="file", event_type="file_created", summary=f"New file: f{i}", dedup_key=f"k{i}")
        for i in range(n)
    ]


@pytest.fixture
def p_fired(monkeypatch):
    """Mock the executor seam: records execute() calls, workflow never busy."""
    from backend.apps.workflows import executor
    from backend.apps.workflows.models import WorkflowRun

    calls: list[dict] = []

    async def p_fake_execute(wf, triggered_by="schedule", scheduled_for=None, tested_signature=None, event_context=None, trigger_id=None):
        calls.append(dict(workflow_id=wf.id, triggered_by=triggered_by, event_context=event_context, trigger_id=trigger_id))
        return WorkflowRun(workflow_id=wf.id, status="success", triggered_by=triggered_by)

    monkeypatch.setattr(executor, "execute", p_fake_execute)
    monkeypatch.setattr(executor, "is_workflow_running", lambda wid: False)
    return calls


def test_burst_coalesces_to_one_run(make_wf, p_fired):
    from backend.apps.events import dispatcher, stores
    from backend.apps.workflows import storage

    trig = p_file_trigger()
    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)

    async def scenario():
        await dispatcher.ingest(wf.id, trig, p_events(3))
        await dispatcher.ingest(wf.id, trig, p_events(2))
        await asyncio.sleep(0.1)

    p_run(scenario())
    assert len(p_fired) == 1
    assert p_fired[0]["triggered_by"] == "event"
    assert p_fired[0]["trigger_id"] == trig.id
    assert "New file: f0" in p_fired[0]["event_context"]
    assert stores.load_pending(trig.id) == []  # consumed on fire


def test_disabled_trigger_drops_with_logged_reason(make_wf, p_fired):
    from backend.apps.events import dispatcher, stores
    from backend.apps.workflows import storage

    trig = p_file_trigger(enabled=True)
    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)

    async def scenario():
        await dispatcher.ingest(wf.id, trig, p_events(2))
        # Disable between ingest and flush; the flush re-reads live state.
        live = storage.get_workflow(wf.id)
        live.event_triggers[0].enabled = False
        storage.save_workflow(live)
        await asyncio.sleep(0.1)

    p_run(scenario())
    assert p_fired == []
    log = stores.read_log(wf.id)
    assert any(e.kind == "skipped" and "disabled" in e.summary for e in log)


def test_rate_cap_skips_with_logged_reason(make_wf, p_fired):
    from backend.apps.events import dispatcher, stores
    from backend.apps.workflows import storage

    trig = p_file_trigger(max_fires_per_hour=1)
    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)

    async def scenario():
        await dispatcher.ingest(wf.id, trig, p_events(1))
        await asyncio.sleep(0.05)
        await dispatcher.ingest(wf.id, trig, p_events(1))
        await asyncio.sleep(0.05)

    p_run(scenario())
    assert len(p_fired) == 1
    log = stores.read_log(wf.id)
    assert any(e.kind == "skipped" and "rate cap" in e.summary for e in log)


def test_busy_workflow_requeues_instead_of_dropping(make_wf, p_fired, monkeypatch):
    from backend.apps.events import dispatcher
    from backend.apps.workflows import executor, storage

    trig = p_file_trigger()
    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)

    busy = {"value": True}
    monkeypatch.setattr(executor, "is_workflow_running", lambda wid: busy["value"])
    monkeypatch.setattr(dispatcher, "RETRY_DELAY_SECONDS", 0.02)

    async def scenario():
        await dispatcher.ingest(wf.id, trig, p_events(2))
        await asyncio.sleep(0.05)
        assert p_fired == []  # held, not dropped
        busy["value"] = False
        await asyncio.sleep(0.1)

    p_run(scenario())
    assert len(p_fired) == 1
    assert "f1" in p_fired[0]["event_context"]


def test_predicate_gates_fire(make_wf, p_fired, monkeypatch):
    from backend.apps.events import dispatcher, stores
    from backend.apps.workflows import storage

    trig = p_file_trigger(predicate="only csv files")
    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)

    verdicts = iter([False, None, True])

    async def p_fake_predicate(predicate, events):
        return next(verdicts)

    monkeypatch.setattr(dispatcher, "evaluate_predicate", p_fake_predicate)

    async def scenario():
        for _ in range(3):
            await dispatcher.ingest(wf.id, trig, p_events(1))
            await asyncio.sleep(0.05)

    p_run(scenario())
    # False -> skip, None (aux unavailable) -> skip, True -> fire.
    assert len(p_fired) == 1
    log = stores.read_log(wf.id)
    skips = [e for e in log if e.kind == "skipped"]
    assert len(skips) == 2
    assert any("could not be evaluated" in e.summary for e in skips)


def test_pending_survives_restart(make_wf, p_fired):
    from backend.apps.events import dispatcher, stores
    from backend.apps.workflows import storage

    trig = p_file_trigger(coalesce_seconds=3600)  # window far in the future
    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)

    async def before_restart():
        await dispatcher.ingest(wf.id, trig, p_events(2))

    p_run(before_restart())
    dispatcher.stop()  # simulated shutdown mid-window
    assert len(stores.load_pending(trig.id)) == 2

    async def after_restart():
        fast = trig.model_copy(update={"coalesce_seconds": 0})
        assert dispatcher.restore_pending(wf.id, fast) == 2
        await asyncio.sleep(0.1)

    p_run(after_restart())
    assert len(p_fired) == 1


def test_global_pause_holds_fires(make_wf, p_fired, monkeypatch):
    from backend.apps.events import dispatcher
    from backend.apps.workflows import storage

    trig = p_file_trigger()
    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)
    monkeypatch.setattr(dispatcher, "RETRY_DELAY_SECONDS", 0.02)

    async def scenario():
        storage.set_paused(True)
        await dispatcher.ingest(wf.id, trig, p_events(1))
        await asyncio.sleep(0.05)
        assert p_fired == []
        storage.set_paused(False)
        await asyncio.sleep(0.1)

    p_run(scenario())
    assert len(p_fired) == 1


def test_poll_tick_polls_and_fires(make_wf, p_fired, tmp_path):
    from backend.apps.events import poll_loop
    from backend.apps.workflows import storage

    watch_dir = tmp_path / "polled"
    watch_dir.mkdir()
    trig = p_file_trigger(source=FileWatchSource(path=str(watch_dir)))
    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)

    async def scenario():
        poll_loop.tick()  # baseline poll
        await asyncio.sleep(0.1)
        (watch_dir / "new.txt").write_text("x")
        poll_loop.mark_due(trig.id)  # force due despite poll_seconds
        poll_loop.tick()
        await asyncio.sleep(0.15)

    p_run(scenario())
    assert len(p_fired) == 1
    assert "new.txt" in p_fired[0]["event_context"]
