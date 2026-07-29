"""The always-observing tier: SSE parsing + filtering, the live-source
reconciler's start/stop lifecycle (file signals and stream tasks follow the
trigger set), the kqueue file signal firing on a real directory change, and
the watcher-attention endpoint surfacing repeated failures.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_event_stream_tier.py -v
"""

from __future__ import annotations

import asyncio

import pytest

from backend.apps.events.models import EventTriggerConfig, FileWatchSource, StreamSource


def p_run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def p_events_env(isolated_workflows_data, reset_scheduler_state, monkeypatch, tmp_path):
    from backend.apps.events import dispatcher, poll_loop, stores

    monkeypatch.setattr(stores, "EVENTS_DIR", str(tmp_path / "events"))
    monkeypatch.setattr(stores, "CURSORS_DIR", str(tmp_path / "events" / "cursors"))
    monkeypatch.setattr(stores, "PENDING_DIR", str(tmp_path / "events" / "pending"))
    monkeypatch.setattr(stores, "LOGS_DIR", str(tmp_path / "events" / "logs"))
    monkeypatch.setattr(stores, "FIRES_DIR", str(tmp_path / "events" / "fires"))
    monkeypatch.setattr(stores, "HEALTH_DIR", str(tmp_path / "events" / "health"))
    dispatcher.stop()
    poll_loop.reset_state()
    yield
    dispatcher.stop()
    poll_loop.reset_state()


def test_sse_parse_and_filter():
    from backend.apps.events.adapters.stream_watch import parse_sse_data, stream_event_from

    assert parse_sse_data(["data: hello", "data: world"]) == "hello\nworld"
    assert parse_sse_data([": keepalive comment"]) is None
    assert parse_sse_data(["event: message"]) is None

    assert stream_event_from('{"title": "Berlin Wall"}', "berlin") is not None
    assert stream_event_from('{"title": "Paris"}', "berlin") is None
    e = stream_event_from("x" * 5000, "")
    assert len(e.summary) <= 200
    assert len(e.payload["data"]) <= 2000


def test_reconciler_starts_and_stops_live_sources(make_wf, monkeypatch, tmp_path):
    from backend.apps.events import poll_loop
    from backend.apps.workflows import storage

    started: list[str] = []
    stopped: list[str] = []

    def p_fake_signal(path, on_change):
        started.append(path)
        return lambda: stopped.append(path)

    async def p_fake_stream(workflow_id, trigger, source):
        await asyncio.sleep(3600)

    monkeypatch.setattr(poll_loop, "start_file_signal", p_fake_signal)
    monkeypatch.setattr(poll_loop, "run_stream_source", p_fake_stream)

    watch_dir = str(tmp_path / "sig")
    file_trig = EventTriggerConfig(source=FileWatchSource(path=watch_dir))
    stream_trig = EventTriggerConfig(source=StreamSource(url="https://feed.example/sse"))
    wf = make_wf(event_triggers=[file_trig, stream_trig])
    storage.save_workflow(wf)

    async def scenario():
        poll_loop.reconcile_live_sources()
        assert started == [watch_dir]
        assert poll_loop.live_source_count() == 2  # file signal + stream task

        # Removing the triggers stops both handles.
        live = storage.get_workflow(wf.id)
        live.event_triggers = []
        storage.save_workflow(live)
        poll_loop.reconcile_live_sources()
        assert poll_loop.live_source_count() == 0
        assert stopped == [watch_dir]
        await asyncio.sleep(0)

    p_run(scenario())


def test_kqueue_signal_fires_on_real_change(tmp_path):
    from backend.apps.events.adapters.file_signal import start_file_signal

    watch_dir = tmp_path / "instant"
    watch_dir.mkdir()

    async def scenario() -> bool:
        fired = asyncio.Event()
        stop = start_file_signal(str(watch_dir), fired.set)
        if stop is None:
            pytest.skip("kqueue unavailable on this platform")
        try:
            (watch_dir / "new.txt").write_text("x")
            await asyncio.wait_for(fired.wait(), timeout=2.0)
            return True
        finally:
            stop()

    assert p_run(scenario()) is True


def test_attention_endpoint_surfaces_repeat_failures(make_wf):
    from backend.apps.events import stores
    from backend.apps.workflows import storage
    from backend.apps.workflows.workflows import triggers_attention

    trig = EventTriggerConfig(source=StreamSource(url="https://dead.example/sse"))
    healthy = EventTriggerConfig(source=FileWatchSource(path="/tmp/x"))
    wf = make_wf(event_triggers=[trig, healthy])
    storage.save_workflow(wf)

    for _ in range(4):
        stores.record_poll_failure(trig.id, "connect refused")
    assert p_run(triggers_attention()) == {"attention": []}  # 4 failures = self-heal territory, not the user's yet

    stores.record_poll_failure(trig.id, "connect refused")
    res = p_run(triggers_attention())
    assert len(res["attention"]) == 1
    item = res["attention"][0]
    assert item["trigger_id"] == trig.id
    assert item["consecutive_failures"] == 5
    assert "connect refused" in item["last_error"]

    stores.clear_poll_failures(trig.id)
    assert p_run(triggers_attention()) == {"attention": []}


def test_adaptive_pace_tunes_itself():
    from backend.apps.events import poll_loop

    auto = EventTriggerConfig(source=StreamSource(url="x"))  # placeholder; pace keys off trigger id + kind
    web_auto = EventTriggerConfig(source={"kind": "web", "url": "https://a.b", "watch_for": "", "poll_seconds": 0})
    assert poll_loop.effective_poll_seconds(web_auto) == 300.0  # default until observed

    poll_loop.pace_update(web_auto, event_count=3)
    assert poll_loop.effective_poll_seconds(web_auto) == 150.0  # events halve toward the floor
    for _ in range(5):
        poll_loop.pace_update(web_auto, event_count=0)
    assert poll_loop.effective_poll_seconds(web_auto) == 225.0  # 5 quiet polls stretch 1.5x

    for _ in range(20):
        poll_loop.pace_update(web_auto, event_count=9)
    assert poll_loop.effective_poll_seconds(web_auto) == 60.0  # floor holds

    fixed = EventTriggerConfig(source={"kind": "web", "url": "https://a.b", "watch_for": "", "poll_seconds": 600})
    poll_loop.pace_update(fixed, event_count=9)
    assert poll_loop.effective_poll_seconds(fixed) == 600.0  # explicit cadence is never second-guessed
    assert auto.source.kind == "stream"


def test_self_heal_fixes_url_or_escalates(make_wf, monkeypatch):
    from backend.apps.events.adapters import agent_check as ac
    from backend.apps.events.adapters import heal_trigger as ht
    from backend.apps.events import stores
    from backend.apps.workflows import storage

    trig = EventTriggerConfig(source=StreamSource(url="https://old.example/feed"))
    wf = make_wf(event_triggers=[trig])
    storage.save_workflow(wf)
    stores.record_poll_failure(trig.id, "410 Gone")

    async def p_fix_turn(model, prompt, **kwargs):
        assert "https://old.example/feed" in prompt and "410 Gone" in prompt
        return "Investigated.\nFIX_URL: https://new.example/feed"

    monkeypatch.setattr(ac, "run_check_turn", p_fix_turn)
    assert p_run(ht.attempt_heal(wf.id, trig)) is True
    healed = storage.get_workflow(wf.id).event_triggers[0]
    assert healed.source.url == "https://new.example/feed"
    assert stores.read_poll_health(trig.id) == {}  # failure streak cleared
    assert any("Self-healed" in e.summary for e in stores.read_log(wf.id))

    async def p_cannot(model, prompt, **kwargs):
        return "CANNOT_FIX: the site now requires a sign-in"

    monkeypatch.setattr(ac, "run_check_turn", p_cannot)
    assert p_run(ht.attempt_heal(wf.id, healed)) is False
    assert storage.get_workflow(wf.id).event_triggers[0].source.url == "https://new.example/feed"  # untouched
    assert any("requires a sign-in" in e.summary for e in stores.read_log(wf.id))
