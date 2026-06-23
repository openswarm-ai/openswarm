"""Backend semantics tests for the scheduled-tasks fix.

Covers:
  - DST-safe wall-clock math (spring forward + fall back) via zoneinfo
  - End conditions (ends_at + max_runs) auto-disable the schedule
  - Cost cap skips fires with a clear error
  - Freeze-default on for new scheduled non-source-session creates
  - Audit log captures field diffs
  - /workflows/active surfaces in-process running runs
  - Legacy timezone="local" coerced in memory at load
  - Storage paused flag round-trips
  - Month math no longer clamps to day 28
  - Server-side escalation kicks tasks (and ack cancels them)

Run:
    pip install -r backend/requirements.txt -r backend/requirements-dev.txt
    cd backend && python -m pytest tests/test_workflows_semantics.py -v
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest


@pytest.fixture(autouse=True)
def isolated_data_dir(monkeypatch, tmp_path):
    """Point storage at a fresh tmpdir per test so we never touch a real
    install's workflows data. Reloads in-process module state so each test
    starts with empty caches."""
    from backend.apps.workflows import storage as _storage
    from backend.apps.workflows import escalation as _escalation
    from backend.apps.workflows import executor as _executor
    monkeypatch.setattr(_storage, "DATA_DIR", str(tmp_path / "workflows"))
    monkeypatch.setattr(_storage, "RUNS_DIR", str(tmp_path / "workflows" / "runs"))
    monkeypatch.setattr(_storage, "PAUSED_FILE", str(tmp_path / "workflows" / "paused.json"))
    monkeypatch.setattr(_storage, "_workflow_cache", {})
    monkeypatch.setattr(_storage, "_runs_cache", {})
    monkeypatch.setattr(_storage, "_cache_loaded", False)
    monkeypatch.setattr(_storage, "_paused", False)
    # Reset escalation registry between tests.
    _escalation._tasks.clear()
    _escalation._state.clear()
    _executor._run_control.clear()
    _executor._run_pause_override.clear()
    # Also clear audit dir reference; audit.py reads DATA_DIR at import via
    # module-level expression, so reach in and override the AUDIT_DIR too.
    from backend.apps.workflows import audit as _audit
    monkeypatch.setattr(_audit, "AUDIT_DIR", str(tmp_path / "workflows" / "audit"))
    yield


def _make_wf(**overrides):
    from backend.apps.workflows.models import Workflow, ScheduleConfig, WorkflowStep
    base = dict(
        title="t",
        steps=[WorkflowStep(text="hi")],
        schedule=ScheduleConfig(enabled=True, repeat_unit="day", repeat_every=1, hour=9, minute=0, timezone="America/Los_Angeles"),
    )
    base.update(overrides)
    return Workflow(**base)


class _NoopDebug:
    def __call__(self, *args, **kwargs):
        return None


# --- DST tests ---------------------------------------------------------------

def test_dst_spring_forward_weekly():
    """A 2:30am LA weekly Sunday schedule lands on 3:30am LA on the spring-
    forward Sunday (2025-03-09) because the wall clock skips 02:30."""
    from backend.apps.workflows.scheduler import _next_fire_after
    from backend.apps.workflows.models import ScheduleConfig
    tz = ZoneInfo("America/Los_Angeles")
    sched = ScheduleConfig(enabled=True, repeat_unit="week", repeat_every=1, on_days=[0], hour=2, minute=30, timezone="America/Los_Angeles")
    # Saturday 2025-03-08 23:00 LA, asking "what's the next Sunday 2:30?"
    ref_local = datetime(2025, 3, 8, 23, 0, tzinfo=tz)
    nxt = _next_fire_after(sched, ref_local.astimezone(timezone.utc))
    assert nxt is not None
    nxt_local = nxt.astimezone(tz)
    # 02:30 wall-clock on the spring-forward day doesn't exist; zoneinfo
    # resolves it forward to 03:30. The point is the *date* lands on the
    # 9th, not the 8th and not the 16th.
    assert nxt_local.date() == datetime(2025, 3, 9).date()
    assert nxt_local.hour in (2, 3)


def test_dst_fall_back_no_double_fire():
    """A 9am LA daily schedule should fire exactly once on the fall-back day
    (2025-11-02) and the next fire is the 3rd, not the 2nd again."""
    from backend.apps.workflows.scheduler import _next_fire_after
    from backend.apps.workflows.models import ScheduleConfig
    tz = ZoneInfo("America/Los_Angeles")
    sched = ScheduleConfig(enabled=True, repeat_unit="day", repeat_every=1, hour=9, minute=0, timezone="America/Los_Angeles")
    ref_local = datetime(2025, 11, 1, 23, 0, tzinfo=tz)
    nxt = _next_fire_after(sched, ref_local.astimezone(timezone.utc))
    assert nxt.astimezone(tz).date() == datetime(2025, 11, 2).date()
    # After firing on the 2nd, the next fire should be the 3rd, not a
    # second 2nd from the duplicated hour.
    after = _next_fire_after(sched, nxt)
    assert after.astimezone(tz).date() == datetime(2025, 11, 3).date()


def test_unconfigured_weekly_schedule_has_no_next_fire():
    from backend.apps.workflows.models import ScheduleConfig
    from backend.apps.workflows.scheduler import _next_fire_after
    sched = ScheduleConfig(
        enabled=True,
        repeat_unit="week",
        repeat_every=1,
        on_days=[],
        hour=9,
        minute=0,
        timezone="America/Los_Angeles",
    )
    ref = datetime(2026, 6, 17, 8, 0, tzinfo=timezone.utc)
    assert _next_fire_after(sched, ref) is None


def test_reconcile_disables_enabled_weekly_without_days():
    from backend.apps.workflows import storage, scheduler
    from backend.apps.workflows.models import ScheduleConfig
    wf = _make_wf(
        schedule=ScheduleConfig(
            enabled=True,
            repeat_unit="week",
            repeat_every=1,
            on_days=[],
            hour=9,
            minute=0,
            timezone="America/Los_Angeles",
        )
    )
    wf.next_run_at = datetime.now(timezone.utc) + timedelta(days=1)
    storage.save_workflow(wf)
    scheduler.reconcile_on_startup()
    after = storage.get_workflow(wf.id)
    assert after.schedule.enabled is False
    assert after.next_run_at is None


# --- End condition tests -----------------------------------------------------

def test_max_runs_disables_schedule():
    from backend.apps.workflows import storage, scheduler
    wf = _make_wf()
    wf.schedule.max_runs = 2
    wf.schedule.runs_count = 2
    wf.next_run_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    storage.save_workflow(wf)
    asyncio.new_event_loop().run_until_complete(scheduler._tick())
    after = storage.get_workflow(wf.id)
    assert after.schedule.enabled is False
    assert after.next_run_at is None


def test_ends_at_disables_schedule():
    from backend.apps.workflows import storage, scheduler
    wf = _make_wf()
    wf.schedule.ends_at = datetime.now(timezone.utc) - timedelta(days=1)
    wf.next_run_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    storage.save_workflow(wf)
    asyncio.new_event_loop().run_until_complete(scheduler._tick())
    after = storage.get_workflow(wf.id)
    assert after.schedule.enabled is False


# --- Month-day-31 (formerly clamped to 28) -----------------------------------

def test_month_repeat_no_longer_clamps_to_28():
    """An every-month schedule starting on March 31 should next fire on
    April 30 (last day of April), then May 31, then June 30."""
    from backend.apps.workflows.scheduler import _next_fire_after
    from backend.apps.workflows.models import ScheduleConfig
    tz = ZoneInfo("America/Los_Angeles")
    sched = ScheduleConfig(enabled=True, repeat_unit="month", repeat_every=1, hour=9, minute=0, timezone="America/Los_Angeles")
    ref_local = datetime(2025, 3, 31, 10, 0, tzinfo=tz)  # past 9am on the 31st
    nxt = _next_fire_after(sched, ref_local.astimezone(timezone.utc))
    assert nxt.astimezone(tz).date() == datetime(2025, 4, 30).date()


def test_month_repeat_can_pin_first_day():
    from backend.apps.workflows.scheduler import _next_fire_after
    from backend.apps.workflows.models import ScheduleConfig
    tz = ZoneInfo("America/Los_Angeles")
    sched = ScheduleConfig(
        enabled=True,
        repeat_unit="month",
        repeat_every=1,
        day_of_month=1,
        hour=9,
        minute=0,
        timezone="America/Los_Angeles",
    )
    ref_local = datetime(2025, 6, 20, 10, 0, tzinfo=tz)
    nxt = _next_fire_after(sched, ref_local.astimezone(timezone.utc))
    assert nxt.astimezone(tz).date() == datetime(2025, 7, 1).date()


def test_month_repeat_every_respects_interval_after_clamped_day():
    from backend.apps.workflows.scheduler import _next_fire_after
    from backend.apps.workflows.models import ScheduleConfig
    sched = ScheduleConfig(
        enabled=True,
        repeat_unit="month",
        repeat_every=2,
        day_of_month=31,
        hour=9,
        minute=0,
        timezone="UTC",
    )
    nxt = _next_fire_after(sched, datetime(2025, 1, 31, 9, 0, tzinfo=timezone.utc))
    assert nxt == datetime(2025, 3, 31, 9, 0, tzinfo=timezone.utc)


def test_monthly_create_pins_missing_day_to_creation_day(monkeypatch):
    from backend.apps.workflows import workflows as workflows_mod
    from backend.apps.workflows.models import WorkflowCreate, ScheduleConfig, WorkflowStep
    from backend.apps.workflows.scheduler import _next_fire_after

    class FrozenDateTime(datetime):
        @classmethod
        def now(cls, tz=None):
            base = datetime(2025, 3, 31, 10, 0, tzinfo=timezone.utc)
            return base.astimezone(tz) if tz is not None else base.replace(tzinfo=None)

    monkeypatch.setattr(workflows_mod, "datetime", FrozenDateTime)
    body = WorkflowCreate(
        title="monthly",
        steps=[WorkflowStep(text="say hi")],
        schedule=ScheduleConfig(
            enabled=True,
            repeat_unit="month",
            repeat_every=1,
            hour=9,
            minute=0,
            timezone="UTC",
        ),
    )
    result = asyncio.new_event_loop().run_until_complete(workflows_mod.create_workflow(body))
    assert result["schedule"]["day_of_month"] == 31

    sched = ScheduleConfig(**result["schedule"])
    nxt = _next_fire_after(sched, datetime(2025, 4, 30, 9, 0, tzinfo=timezone.utc))
    assert nxt == datetime(2025, 5, 31, 9, 0, tzinfo=timezone.utc)


def test_daily_repeat_every_skips_by_interval():
    from backend.apps.workflows.scheduler import _next_fire_after
    from backend.apps.workflows.models import ScheduleConfig
    sched = ScheduleConfig(
        enabled=True,
        repeat_unit="day",
        repeat_every=3,
        hour=9,
        minute=0,
        timezone="UTC",
    )
    nxt = _next_fire_after(sched, datetime(2026, 6, 20, 9, 0, tzinfo=timezone.utc))
    assert nxt == datetime(2026, 6, 23, 9, 0, tzinfo=timezone.utc)


def test_weekly_repeat_every_skips_inactive_weeks():
    from backend.apps.workflows.scheduler import _next_fire_after
    from backend.apps.workflows.models import ScheduleConfig
    sched = ScheduleConfig(
        enabled=True,
        repeat_unit="week",
        repeat_every=2,
        on_days=[1],
        hour=9,
        minute=0,
        timezone="UTC",
    )
    nxt = _next_fire_after(sched, datetime(2026, 6, 22, 9, 0, tzinfo=timezone.utc))
    assert nxt == datetime(2026, 7, 6, 9, 0, tzinfo=timezone.utc)


def test_weekly_every_n_weeks_phase_is_stable_across_recompute():
    """The bi-weekly phase must anchor to created_at, not to whenever the
    recompute happens. Computing from an 'on' week and from the following
    'off' week must both land on the same created_at-anchored grid; otherwise
    a tick/kick in an off week slides the whole cadence by weeks."""
    from backend.apps.workflows.scheduler import compute_next_fire
    from backend.apps.workflows.models import ScheduleConfig
    # Created on Mon 2026-06-08. Every 2 weeks on Monday => fires 06-08,
    # 06-22, 07-06, 07-20 (UTC). 06-15 and 06-29 are 'off' weeks.
    wf = _make_wf(
        created_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
        schedule=ScheduleConfig(
            enabled=True, repeat_unit="week", repeat_every=2, on_days=[1],
            hour=9, minute=0, timezone="UTC",
        ),
    )
    # From just after the 06-22 fire (on-week) -> 07-06.
    assert compute_next_fire(wf, datetime(2026, 6, 23, tzinfo=timezone.utc)) == \
        datetime(2026, 7, 6, 9, 0, tzinfo=timezone.utc)
    # From an off-week (06-30) the next fire is STILL 07-06, not 07-13.
    assert compute_next_fire(wf, datetime(2026, 6, 30, tzinfo=timezone.utc)) == \
        datetime(2026, 7, 6, 9, 0, tzinfo=timezone.utc)
    # From the off-week between the first two fires (06-16) -> 06-22, not 06-29.
    assert compute_next_fire(wf, datetime(2026, 6, 16, tzinfo=timezone.utc)) == \
        datetime(2026, 6, 22, 9, 0, tzinfo=timezone.utc)


def test_ran_late_is_measured_from_start_not_finish():
    """A run that STARTS on time is 'success' no matter how long it runs; a run
    that starts >5min after its slot is 'ran_late'."""
    from backend.apps.workflows.executor import p_ran_late
    slot = datetime(2026, 6, 22, 9, 0, tzinfo=timezone.utc)
    # Started on time -> not late (even though such a run might finish much later).
    assert p_ran_late(slot, slot) is False
    assert p_ran_late(slot + timedelta(minutes=4), slot) is False
    # Started well after the slot -> late.
    assert p_ran_late(slot + timedelta(minutes=6), slot) is True
    # Naive started_at (host-local, as datetime.now() produces) is normalized
    # to UTC rather than subtracted across the offset.
    naive_on_time = slot.astimezone().replace(tzinfo=None)
    assert p_ran_late(naive_on_time, slot) is False


def test_frozen_empty_tool_set_does_not_fall_back_to_defaults():
    from backend.apps.workflows.executor import _resolve_allowed_tools
    from backend.apps.workflows.models import ActionsConfig
    wf = _make_wf(actions=ActionsConfig(freeze=True, configured_sets=[]))
    assert _resolve_allowed_tools(wf) == []


def test_calendar_occurrences_use_schedule_timezone_not_viewer_timezone():
    """A 9am New York schedule returns UTC instants. The frontend can then
    render those instants in the viewer's current timezone."""
    from backend.apps.workflows import scheduler
    from backend.apps.workflows.models import ScheduleConfig
    wf = _make_wf(
        schedule=ScheduleConfig(
            enabled=True,
            repeat_unit="day",
            repeat_every=1,
            hour=9,
            minute=0,
            timezone="America/New_York",
        )
    )
    wf.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    start = datetime(2026, 6, 18, 0, 0, tzinfo=timezone.utc)
    end = datetime(2026, 6, 20, 0, 0, tzinfo=timezone.utc)
    fires = scheduler.occurrences_between(wf, start, end)
    assert len(fires) == 2
    assert fires[0].astimezone(ZoneInfo("America/New_York")).hour == 9
    assert fires[0].astimezone(ZoneInfo("America/Los_Angeles")).hour == 6


def test_calendar_occurrences_stay_wall_clock_across_dst():
    from backend.apps.workflows import scheduler
    from backend.apps.workflows.models import ScheduleConfig
    wf = _make_wf(
        schedule=ScheduleConfig(
            enabled=True,
            repeat_unit="day",
            repeat_every=1,
            hour=9,
            minute=0,
            timezone="America/New_York",
        )
    )
    wf.created_at = datetime(2025, 1, 1, tzinfo=timezone.utc)
    fires = scheduler.occurrences_between(
        wf,
        datetime(2025, 3, 8, 0, 0, tzinfo=timezone.utc),
        datetime(2025, 3, 11, 0, 0, tzinfo=timezone.utc),
    )
    ny = ZoneInfo("America/New_York")
    locals_ = [f.astimezone(ny) for f in fires]
    assert [d.date() for d in locals_] == [
        datetime(2025, 3, 8).date(),
        datetime(2025, 3, 9).date(),
        datetime(2025, 3, 10).date(),
    ]
    assert all((d.hour, d.minute) == (9, 0) for d in locals_)
    assert [f.hour for f in fires] == [14, 13, 13]


def test_calendar_occurrences_honor_end_conditions():
    from backend.apps.workflows import scheduler
    from backend.apps.workflows.models import ScheduleConfig
    start = datetime(2026, 6, 18, 0, 0, tzinfo=timezone.utc)
    end = datetime(2026, 6, 22, 0, 0, tzinfo=timezone.utc)
    wf = _make_wf(
        schedule=ScheduleConfig(
            enabled=True,
            repeat_unit="day",
            repeat_every=1,
            hour=9,
            minute=0,
            timezone="UTC",
            max_runs=3,
            runs_count=1,
            ends_at=datetime(2026, 6, 21, 0, 0, tzinfo=timezone.utc),
        )
    )
    wf.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    fires = scheduler.occurrences_between(wf, start, end)
    assert [f.date() for f in fires] == [
        datetime(2026, 6, 18).date(),
        datetime(2026, 6, 19).date(),
    ]

    wf.schedule.enabled = False
    assert scheduler.occurrences_between(wf, start, end) == []

    wf.schedule.enabled = True
    wf.schedule.repeat_unit = "week"
    wf.schedule.on_days = []
    assert scheduler.occurrences_between(wf, start, end) == []


def test_calendar_endpoint_returns_sorted_utc_events():
    from backend.apps.workflows import storage
    from backend.apps.workflows.workflows import list_calendar_events
    from backend.apps.workflows.models import ScheduleConfig
    wf = _make_wf(
        schedule=ScheduleConfig(
            enabled=True,
            repeat_unit="day",
            repeat_every=1,
            hour=9,
            minute=0,
            timezone="America/New_York",
        )
    )
    wf.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    storage.save_workflow(wf)

    async def runner():
        return await list_calendar_events(
            from_="2026-06-18T00:00:00+00:00",
            to="2026-06-20T00:00:00+00:00",
        )

    res = asyncio.new_event_loop().run_until_complete(runner())
    assert [e["workflow_id"] for e in res["events"]] == [wf.id, wf.id]
    assert res["events"][0]["fire_at"].startswith("2026-06-18T13:00:00")


# --- Cost cap ----------------------------------------------------------------

def test_cost_cap_skips_with_clear_error(monkeypatch):
    from backend.apps.workflows import storage, executor
    from backend.apps.workflows.models import WorkflowRun
    wf = _make_wf()
    wf.cost_cap_usd_monthly = 1.0
    storage.save_workflow(wf)
    storage.record_run(WorkflowRun(workflow_id=wf.id, status="success", cost_usd=0.6, started_at=datetime.now(timezone.utc), finished_at=datetime.now(timezone.utc)))
    storage.record_run(WorkflowRun(workflow_id=wf.id, status="success", cost_usd=0.6, started_at=datetime.now(timezone.utc), finished_at=datetime.now(timezone.utc)))

    async def fake_launch(*a, **k):
        raise AssertionError("agent_manager should not be reached when cost-capped")

    # Patch agent_manager.launch_agent so we'd fail loudly if the cap
    # didn't short-circuit before launch.
    from backend.apps.agents import agent_manager
    monkeypatch.setattr(agent_manager.agent_manager, "launch_agent", fake_launch)

    run = asyncio.new_event_loop().run_until_complete(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "skipped"
    assert "Monthly cost cap reached" in (run.error or "")


# --- Freeze-default for scheduled non-source-session creates ----------------

def test_freeze_defaults_on_for_scheduled_create():
    """POST /workflows/create with schedule.enabled=true and no source
    session should flip actions.freeze=True to keep blast radius small."""
    from backend.apps.workflows.workflows import create_workflow
    from backend.apps.workflows.models import WorkflowCreate, ScheduleConfig, ActionsConfig, WorkflowStep
    body = WorkflowCreate(
        title="scheduled",
        steps=[WorkflowStep(text="say hi")],
        schedule=ScheduleConfig(enabled=True, repeat_unit="day", repeat_every=1, hour=9, minute=0),
        actions=ActionsConfig(freeze=False, configured_sets=[]),
    )
    result = asyncio.new_event_loop().run_until_complete(create_workflow(body))
    assert result["actions"]["freeze"] is True


def test_freeze_not_forced_when_source_session_present():
    """Source-session creates inherit the chat's choices; we don't override."""
    from backend.apps.workflows.workflows import create_workflow
    from backend.apps.workflows.models import WorkflowCreate, ScheduleConfig, ActionsConfig, WorkflowStep
    body = WorkflowCreate(
        title="from chat",
        source_session_id="sess-1",
        steps=[WorkflowStep(text="say hi")],
        schedule=ScheduleConfig(enabled=True, repeat_unit="day", repeat_every=1, hour=9, minute=0),
        actions=ActionsConfig(freeze=False, configured_sets=[]),
    )
    result = asyncio.new_event_loop().run_until_complete(create_workflow(body))
    assert result["actions"]["freeze"] is False


def test_source_session_create_inherits_allowed_tools():
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.workflows.workflows import create_workflow
    from backend.apps.workflows.models import WorkflowCreate, ScheduleConfig, ActionsConfig, WorkflowStep
    agent_manager.sessions["sess-allowed"] = SimpleNamespace(
        allowed_tools=["Read"],
        approval_decisions=[],
        messages=[],
        tool_latencies={},
    )
    try:
        body = WorkflowCreate(
            title="from restricted chat",
            source_session_id="sess-allowed",
            steps=[WorkflowStep(text="say hi")],
            schedule=ScheduleConfig(enabled=True, repeat_unit="day", repeat_every=1, hour=9, minute=0),
            actions=ActionsConfig(freeze=False, configured_sets=[]),
        )
        result = asyncio.new_event_loop().run_until_complete(create_workflow(body))
    finally:
        agent_manager.sessions.pop("sess-allowed", None)
    assert result["actions"]["freeze"] is True
    assert result["actions"]["configured_sets"] == ["Read"]


def test_create_enabled_schedule_normalizes_local_timezone(monkeypatch):
    from backend.apps.workflows import scheduler
    from backend.apps.workflows.workflows import create_workflow
    from backend.apps.workflows.models import WorkflowCreate, ScheduleConfig, WorkflowStep
    monkeypatch.setenv("OPENSWARM_TIMEZONE", "America/Chicago")
    monkeypatch.setattr(scheduler, "_host_tz_cache", None)
    body = WorkflowCreate(
        title="local-tz-create",
        steps=[WorkflowStep(text="say hi")],
        schedule=ScheduleConfig(
            enabled=True,
            repeat_unit="day",
            repeat_every=1,
            hour=9,
            minute=0,
            timezone="local",
        ),
    )
    result = asyncio.new_event_loop().run_until_complete(create_workflow(body))
    assert result["schedule"]["timezone"] == "America/Chicago"


def test_enable_schedule_normalizes_local_timezone_and_preserves_concrete_timezone(monkeypatch):
    from backend.apps.workflows import storage, scheduler
    from backend.apps.workflows.workflows import update_workflow
    from backend.apps.workflows.models import WorkflowUpdate, ScheduleConfig
    monkeypatch.setenv("OPENSWARM_TIMEZONE", "America/Denver")
    monkeypatch.setattr(scheduler, "_host_tz_cache", None)

    wf = _make_wf()
    wf.schedule.enabled = False
    wf.schedule.timezone = "local"
    storage.save_workflow(wf)

    async def enable_runner():
        sched = ScheduleConfig(**wf.schedule.model_dump(mode="json"))
        sched.enabled = True
        return await update_workflow(wf.id, WorkflowUpdate(schedule=sched), if_match=None)

    enabled = asyncio.new_event_loop().run_until_complete(enable_runner())
    assert enabled["schedule"]["timezone"] == "America/Denver"

    stored = storage.get_workflow(wf.id)
    sched = ScheduleConfig(**stored.schedule.model_dump(mode="json"))
    sched.hour = 10

    async def edit_runner():
        return await update_workflow(wf.id, WorkflowUpdate(schedule=sched), if_match=None)

    edited = asyncio.new_event_loop().run_until_complete(edit_runner())
    assert edited["schedule"]["timezone"] == "America/Denver"
    assert edited["schedule"]["hour"] == 10


# --- Audit log ---------------------------------------------------------------

def test_audit_log_records_title_change():
    from backend.apps.workflows import audit
    audit.log_change("wf-1", "user", {"title": "old"}, {"title": "new"})
    entries = audit.read_tail("wf-1", limit=10)
    assert len(entries) == 1
    diff = entries[0]["diff"]
    assert diff["title"]["before"] == "old"
    assert diff["title"]["after"] == "new"


def test_audit_log_no_op_when_unchanged():
    from backend.apps.workflows import audit
    audit.log_change("wf-2", "user", {"title": "same"}, {"title": "same"})
    assert audit.read_tail("wf-2") == []


# --- /workflows/active -------------------------------------------------------

def test_list_active_reflects_running_map():
    from backend.apps.workflows import storage, executor, scheduler
    wf = _make_wf(title="active-test")
    storage.save_workflow(wf)
    from backend.apps.workflows.models import WorkflowRun
    run = WorkflowRun(workflow_id=wf.id, status="running")
    storage.record_run(run)
    executor._running[wf.id] = run.id
    try:
        active = scheduler.list_active()
        assert len(active) == 1
        assert active[0]["workflow_id"] == wf.id
        assert active[0]["title"] == "active-test"
    finally:
        executor._running.pop(wf.id, None)


# --- Legacy tz coercion ------------------------------------------------------

def test_legacy_timezone_coerced_on_load(monkeypatch):
    from backend.apps.workflows import storage
    storage._ensure_dirs()
    wf_id = "legacy-wf"
    legacy_blob = {
        "id": wf_id,
        "title": "legacy",
        "schedule": {
            "enabled": False, "repeat_every": 1, "repeat_unit": "week",
            "on_days": [], "hour": 9, "minute": 0, "timezone": "local",
            "on_missed": "skip", "ends_at": None, "max_runs": None, "runs_count": 0,
        },
    }
    with open(os.path.join(storage.DATA_DIR, f"{wf_id}.json"), "w") as f:
        json.dump(legacy_blob, f)
    monkeypatch.setenv("OPENSWARM_TIMEZONE", "America/Los_Angeles")
    monkeypatch.setattr(storage, "_cache_loaded", False)
    loaded = storage.get_workflow(wf_id)
    assert loaded is not None
    # In-memory should be the host zone, not "local".
    assert loaded.schedule.timezone == "America/Los_Angeles"
    # On-disk file should be unchanged (still "local") so we don't churn
    # mtime on every restart.
    with open(os.path.join(storage.DATA_DIR, f"{wf_id}.json")) as f:
        on_disk = json.load(f)
    assert on_disk["schedule"]["timezone"] == "local"


# --- Paused flag -------------------------------------------------------------

def test_paused_flag_persists_and_blocks_tick():
    from backend.apps.workflows import storage, scheduler
    wf = _make_wf()
    wf.next_run_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    storage.save_workflow(wf)
    storage.set_paused(True)
    # Reload simulates a backend restart.
    storage._cache_loaded = False
    assert storage.get_paused() is True
    # Tick must not advance next_run_at when paused.
    before = storage.get_workflow(wf.id).next_run_at
    asyncio.new_event_loop().run_until_complete(scheduler._tick())
    after = storage.get_workflow(wf.id).next_run_at
    assert before == after


def test_pause_run_returns_confirmed_state_before_agent_stop_finishes(monkeypatch):
    async def scenario():
        from backend.apps.workflows import storage
        from backend.apps.workflows.models import WorkflowRun
        monkeypatch.setitem(sys.modules, "debug", _NoopDebug())
        from backend.apps.workflows import workflows as routes
        from backend.apps.agents import agent_manager as agent_manager_module

        wf = _make_wf()
        storage.save_workflow(wf)
        run = WorkflowRun(workflow_id=wf.id, status="running", session_id="s1", triggered_by="manual")
        storage.record_run(run)
        broadcasts: list[bool] = []

        async def fake_broadcast(_workflow_id, updated_run):
            broadcasts.append(updated_run.paused)

        stop_started = asyncio.Event()
        stop_release = asyncio.Event()

        async def fake_stop_agent(_session_id):
            stop_started.set()
            await stop_release.wait()

        monkeypatch.setattr(routes, "_broadcast_run", fake_broadcast)
        monkeypatch.setattr(agent_manager_module.agent_manager, "stop_agent", fake_stop_agent)

        result = await asyncio.wait_for(routes.pause_run(run.id), timeout=0.05)
        assert result["run"]["paused"] is True
        assert storage.list_runs(wf.id)[0].paused is True
        assert broadcasts[-1] is True
        await asyncio.wait_for(stop_started.wait(), timeout=0.05)
        stop_release.set()
        await asyncio.sleep(0)

    asyncio.run(scenario())


def test_resume_run_returns_confirmed_state_before_resume_message_finishes(monkeypatch):
    async def scenario():
        from backend.apps.workflows import storage
        from backend.apps.workflows.models import WorkflowRun
        monkeypatch.setitem(sys.modules, "debug", _NoopDebug())
        from backend.apps.workflows import workflows as routes
        from backend.apps.agents import agent_manager as agent_manager_module

        wf = _make_wf()
        storage.save_workflow(wf)
        run = WorkflowRun(workflow_id=wf.id, status="running", session_id="s1", triggered_by="manual", paused=True)
        storage.record_run(run)
        broadcasts: list[bool] = []

        async def fake_broadcast(_workflow_id, updated_run):
            broadcasts.append(updated_run.paused)

        send_started = asyncio.Event()
        send_release = asyncio.Event()

        async def fake_send_message(_session_id, _prompt, hidden=False):
            assert hidden is True
            send_started.set()
            await send_release.wait()

        monkeypatch.setattr(routes, "_broadcast_run", fake_broadcast)
        monkeypatch.setattr(agent_manager_module.agent_manager, "send_message", fake_send_message)

        result = await asyncio.wait_for(routes.resume_run(run.id), timeout=0.05)
        assert result["run"]["paused"] is False
        assert storage.list_runs(wf.id)[0].paused is False
        assert broadcasts[-1] is False
        await asyncio.wait_for(send_started.wait(), timeout=0.05)
        send_release.set()
        await asyncio.sleep(0)

    asyncio.run(scenario())


# --- Escalation --------------------------------------------------------------

def test_escalation_schedules_and_ack_cancels():
    from backend.apps.workflows import escalation
    from backend.apps.workflows.models import Workflow, PermissionTier, WorkflowRun, ScheduleConfig

    async def runner():
        wf = Workflow(title="t", permissions=[
            PermissionTier(kind="notify"),
            PermissionTier(kind="text", after_minutes=60, phone="+15551234567"),
        ])
        run = WorkflowRun(workflow_id=wf.id, status="success")
        escalation.schedule(wf, run)
        # State should be present immediately.
        await asyncio.sleep(0.01)
        assert escalation.status(run.id) is not None
        # Ack cancels.
        assert escalation.cancel(run.id) is True
        await asyncio.sleep(0.01)
        assert escalation.status(run.id) is None

    asyncio.new_event_loop().run_until_complete(runner())


def test_executor_merge_does_not_clobber_concurrent_patch():
    """Executor's final save must NOT overwrite unrelated fields that
    were PATCHed while the run was in flight. We simulate this by
    capturing a wf, mutating storage's record directly (acting as the
    PATCH that landed mid-run), then asking the executor's persist
    helper to flush its run-side bookkeeping. The patched fields must
    survive.
    """
    from backend.apps.workflows import storage, executor
    from datetime import datetime
    wf = _make_wf(title="t-orig")
    storage.save_workflow(wf)
    # Simulate a user PATCH mid-run.
    storage._workflow_cache[wf.id].title = "t-patched"
    storage._workflow_cache[wf.id].description = "patched while running"
    storage.save_workflow(storage._workflow_cache[wf.id])
    # Executor uses the stale `wf` it captured before the patch. With
    # the merge helper, the patched fields must remain.
    executor._persist_run_fields(wf, {
        "last_run_at": datetime.now(),
        "last_run_status": "success",
    })
    after = storage.get_workflow(wf.id)
    assert after.title == "t-patched", "title clobbered by executor"
    assert after.description == "patched while running", "description clobbered"
    assert after.last_run_status == "success"


def test_executor_delete_during_run_does_not_resurrect():
    """If the workflow was deleted mid-run, executor's persist must
    silently no-op so the deleted record isn't re-written."""
    from backend.apps.workflows import storage, executor
    from datetime import datetime
    wf = _make_wf(title="doomed")
    storage.save_workflow(wf)
    storage.delete_workflow(wf.id)
    executor._persist_run_fields(wf, {
        "last_run_at": datetime.now(),
        "last_run_status": "success",
    }, schedule_runs_count_delta=1)
    assert storage.get_workflow(wf.id) is None


def test_patch_if_match_rejects_stale_write():
    """A PATCH with a stale If-Match must return 409. Without If-Match,
    the request still succeeds (legacy clients keep working until they
    roll out the header)."""
    from backend.apps.workflows.workflows import update_workflow
    from backend.apps.workflows.models import WorkflowUpdate
    from backend.apps.workflows import storage
    from fastapi import HTTPException

    wf = _make_wf(title="optimistic-test")
    storage.save_workflow(wf)
    stale = "1999-01-01T00:00:00"

    async def runner():
        # Stale If-Match → 409.
        try:
            await update_workflow(wf.id, WorkflowUpdate(title="x"), if_match=stale)
            return "no exception"
        except HTTPException as he:
            return he.status_code
    code = asyncio.new_event_loop().run_until_complete(runner())
    assert code == 409, f"stale If-Match should 409, got {code}"

    # Fresh If-Match → 200.
    fresh = storage.get_workflow(wf.id)
    fresh_stamp = fresh.updated_at.isoformat()
    async def runner_ok():
        return await update_workflow(wf.id, WorkflowUpdate(title="y"), if_match=fresh_stamp)
    result = asyncio.new_event_loop().run_until_complete(runner_ok())
    assert result["title"] == "y"

    # Missing If-Match → legacy path still works.
    async def runner_legacy():
        return await update_workflow(wf.id, WorkflowUpdate(title="z"), if_match=None)
    result = asyncio.new_event_loop().run_until_complete(runner_legacy())
    assert result["title"] == "z"


def test_killed_by_restart_message_is_friendly():
    """stuck-run reaper writes a user-facing string, not internal jargon."""
    from backend.apps.workflows import storage, scheduler
    from backend.apps.workflows.models import WorkflowRun
    wf = _make_wf()
    storage.save_workflow(wf)
    storage.record_run(WorkflowRun(workflow_id=wf.id, status="running"))
    scheduler._mark_stuck_runs_failed()
    runs = storage.list_runs(wf.id, limit=10)
    assert any(r.status == "failure" and "Interrupted" in (r.error or "") and "shut down" in (r.error or "") for r in runs)
    assert not any("Killed by restart" in (r.error or "") for r in runs)


def test_run_endpoint_surfaces_skipped_status():
    """POST /workflows/{id}/run returns the skipped status + error when
    a cost-cap or in-flight collision short-circuits the run."""
    from backend.apps.workflows.workflows import run_workflow_now
    from backend.apps.workflows import storage
    from backend.apps.workflows.models import WorkflowRun
    from datetime import datetime, timezone
    wf = _make_wf(title="cap-immediate")
    wf.cost_cap_usd_monthly = 0.01
    storage.save_workflow(wf)
    # Burn the cap with a single $5 historical run.
    storage.record_run(WorkflowRun(workflow_id=wf.id, status="success", cost_usd=5.0,
                                   started_at=datetime.now(timezone.utc),
                                   finished_at=datetime.now(timezone.utc)))

    async def runner():
        return await run_workflow_now(wf.id)
    res = asyncio.new_event_loop().run_until_complete(runner())
    assert res.get("status") == "skipped"
    assert "cost cap" in (res.get("error") or "").lower()


def test_escalation_noop_for_single_tier():
    from backend.apps.workflows import escalation
    from backend.apps.workflows.models import Workflow, PermissionTier, WorkflowRun
    wf = Workflow(title="t", permissions=[PermissionTier(kind="notify")])
    run = WorkflowRun(workflow_id=wf.id, status="success")
    escalation.schedule(wf, run)
    assert escalation.status(run.id) is None
