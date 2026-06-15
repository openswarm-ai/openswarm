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
import tempfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest


@pytest.fixture(autouse=True)
def isolated_data_dir(monkeypatch, tmp_path):
    """Point storage at a fresh tmpdir per test so we never touch a real
    install's workflows data. Reloads in-process module state so each test
    starts with empty caches."""
    from backend.apps.workflows import storage as _storage
    from backend.apps.workflows import escalation as _escalation
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
    from backend.apps.workflows.models import WorkflowCreate, ScheduleConfig, ActionsConfig
    body = WorkflowCreate(
        title="scheduled",
        schedule=ScheduleConfig(enabled=True, repeat_unit="day", repeat_every=1, hour=9, minute=0),
        actions=ActionsConfig(freeze=False, configured_sets=[]),
    )
    result = asyncio.new_event_loop().run_until_complete(create_workflow(body))
    assert result["actions"]["freeze"] is True


def test_freeze_not_forced_when_source_session_present():
    """Source-session creates inherit the chat's choices; we don't override."""
    from backend.apps.workflows.workflows import create_workflow
    from backend.apps.workflows.models import WorkflowCreate, ScheduleConfig, ActionsConfig
    body = WorkflowCreate(
        title="from chat",
        source_session_id="sess-1",
        schedule=ScheduleConfig(enabled=True, repeat_unit="day", repeat_every=1, hour=9, minute=0),
        actions=ActionsConfig(freeze=False, configured_sets=[]),
    )
    result = asyncio.new_event_loop().run_until_complete(create_workflow(body))
    assert result["actions"]["freeze"] is False


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
    assert any(r.status == "failure" and "OpenSwarm closed" in (r.error or "") for r in runs)
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
