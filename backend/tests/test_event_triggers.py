"""Event-trigger building blocks: config clamps + persistence round-trip, the
file adapter's baseline/diff/cap behavior, and the executor's event-context
injection + mid-run trigger-liveness abort. The dispatcher's coordination
rules live in test_event_dispatcher.py.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_event_triggers.py -v
"""

from __future__ import annotations

import asyncio
import os

import pytest

from backend.apps.events.models import EventTriggerConfig, FileWatchSource, WebWatchSource
from backend.apps.workflows.models import WorkflowStep


def p_run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def p_wf_env(isolated_workflows_data, reset_scheduler_state):
    yield


def test_trigger_config_clamps_and_round_trips(make_wf):
    from backend.apps.workflows import storage

    trig = EventTriggerConfig(
        source=FileWatchSource(path="~/Downloads", poll_seconds=1),
        coalesce_seconds=99999,
        max_fires_per_hour=0,
    )
    assert trig.source.poll_seconds == 5
    assert trig.coalesce_seconds == 3600
    assert trig.max_fires_per_hour == 1

    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)
    storage.init()
    reloaded = storage.get_workflow(wf.id)
    assert len(reloaded.event_triggers) == 1
    assert reloaded.event_triggers[0].id == trig.id
    assert reloaded.event_triggers[0].source.kind == "file"
    assert reloaded.event_triggers[0].source.path == "~/Downloads"


def test_file_watch_baselines_then_diffs(tmp_path):
    from backend.apps.events.adapters.file_watch import file_watch

    watch_dir = tmp_path / "watched"
    watch_dir.mkdir()
    (watch_dir / "existing.txt").write_text("old")
    source = FileWatchSource(path=str(watch_dir))

    events, cursor = p_run(file_watch(source, {}))
    assert events == []  # pre-existing files are not "new"

    (watch_dir / "fresh.txt").write_text("hello")
    os.utime(watch_dir / "existing.txt", (1, 1))
    events, cursor = p_run(file_watch(source, cursor))
    kinds = {e.event_type for e in events}
    assert kinds == {"file_created", "file_modified"}

    (watch_dir / "fresh.txt").unlink()
    events, cursor = p_run(file_watch(source, cursor))
    assert [e.event_type for e in events] == ["file_deleted"]
    assert "fresh.txt" in events[0].summary


def test_file_watch_caps_burst(tmp_path):
    from backend.apps.events.adapters import file_watch as fw

    watch_dir = tmp_path / "burst"
    watch_dir.mkdir()
    source = FileWatchSource(path=str(watch_dir))
    events, cursor = p_run(fw.file_watch(source, {}))
    for i in range(fw.MAX_EVENTS_PER_POLL + 10):
        (watch_dir / f"f{i:03d}.txt").write_text("x")
    events, cursor = p_run(fw.file_watch(source, cursor))
    assert len(events) == fw.MAX_EVENTS_PER_POLL + 1
    assert events[-1].event_type == "changes_elided"


def p_fake_pages(monkeypatch, pages: list[str]):
    """Feed web_watch a scripted sequence of page texts through the WebFetchTool seam."""
    from backend.apps.agents.tools import web as p_web

    feed = iter(pages)

    async def p_fake_execute(self, input_data, context):
        return [{"type": "text", "text": next(feed)}]

    monkeypatch.setattr(p_web.WebFetchTool, "execute", p_fake_execute)


def test_web_watch_baseline_dedup_change_error(monkeypatch):
    from backend.apps.events.adapters.web_watch import web_watch

    source = WebWatchSource(url="https://example.com/reserve", watch_for="a reservation opening")
    p_fake_pages(monkeypatch, [
        "Reservations: fully booked",
        "Reservations: fully booked",
        "Reservations: table for 2 available Friday",
        "HTTP error 503 fetching https://example.com/reserve",
    ])

    events, cursor = p_run(web_watch(source, {}))
    assert events == []  # first sight baselines silently

    events, cursor = p_run(web_watch(source, cursor))
    assert events == []  # unchanged page stays quiet

    events, cursor = p_run(web_watch(source, cursor))
    assert len(events) == 1
    assert events[0].event_type == "page_changed"
    assert "a reservation opening" in events[0].summary
    assert "available Friday" in events[0].payload["added"]

    # A fetch failure raises (poll error), never masquerades as a change.
    with pytest.raises(RuntimeError):
        p_run(web_watch(source, cursor))


def test_executor_prepends_context_to_first_step_only(make_wf, fake_agent_manager):
    from backend.apps.workflows import executor, storage

    trig = EventTriggerConfig(source=FileWatchSource(path="/tmp/x"))
    wf = make_wf(
        steps=[WorkflowStep(text="step1"), WorkflowStep(text="step2")],
        event_triggers=[trig],
    )
    storage.save_workflow(wf)
    run = p_run(executor.execute(wf, triggered_by="event", event_context="<trigger_events>CTX</trigger_events>", trigger_id=trig.id))
    assert run.status == "success"
    assert run.triggered_by == "event"
    sent = fake_agent_manager.sent_messages
    assert sent[0] == "<trigger_events>CTX</trigger_events>\n\nstep1"
    assert sent[1] == "step2"


def test_event_run_halts_when_trigger_removed_midrun(make_wf, fake_agent_manager, monkeypatch):
    from backend.apps.agents import agent_manager as p_am
    from backend.apps.workflows import executor, storage

    trig = EventTriggerConfig(source=FileWatchSource(path="/tmp/x"))
    wf = make_wf(
        steps=[WorkflowStep(text="step1"), WorkflowStep(text="step2"), WorkflowStep(text="step3")],
        event_triggers=[trig],
    )
    storage.save_workflow(wf)

    orig = p_am.agent_manager.send_message

    async def wrapped(session_id, text, hidden=False):
        await orig(session_id, text, hidden=hidden)
        if text.endswith("step1"):
            live = storage.get_workflow(wf.id)
            live.event_triggers = []
            storage.save_workflow(live)

    monkeypatch.setattr(p_am.agent_manager, "send_message", wrapped)
    run = p_run(executor.execute(wf, triggered_by="event", event_context="ctx", trigger_id=trig.id))
    assert run.status == "failure"
    assert run.error == "Event trigger removed or disabled"
    assert len(fake_agent_manager.sent_messages) == 1
