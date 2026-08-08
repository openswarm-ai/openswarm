"""A deleted workflow must never come back, by any route.

Field report (Haik, 1.7.4): a scheduled workflow survived deleting it, wiping OpenSwarm data,
deleting the app, and reinstalling. It kept firing every 45 minutes. `delete_workflow` removes the
file and the cache entry, but `save_workflow` was an unconditional upsert that recreates BOTH, so any
write-back from a run that was already in flight resurrected it, fully scheduled. Runs that stall for
1200s make that window enormous, and each resurrection re-armed the timer, so it never died.
"""

import asyncio
from datetime import datetime, timezone

import pytest

from backend.apps.workflows import storage
from backend.apps.workflows.models import Workflow, WorkflowRun, WorkflowStep


def p_make(title: str = "ghost") -> Workflow:
    return Workflow(
        title=title,
        steps=[WorkflowStep(prompt="do a thing")],
        schedule={"enabled": True, "kind": "interval", "every_minutes": 45},
    )


@pytest.fixture(autouse=True)
def p_isolated_store(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", str(tmp_path / "workflows"))
    monkeypatch.setattr(storage, "RUNS_DIR", str(tmp_path / "workflows" / "runs"))
    monkeypatch.setattr(storage, "PAUSED_FILE", str(tmp_path / "workflows" / "paused.json"))
    monkeypatch.setattr(storage, "MISSED_FILE", str(tmp_path / "workflows" / "missed.json"))
    monkeypatch.setattr(storage, "_workflow_cache", {})
    monkeypatch.setattr(storage, "_runs_cache", {})
    monkeypatch.setattr(storage, "_missed_cache", [])
    monkeypatch.setattr(storage, "p_deleted_ids", set(), raising=False)
    monkeypatch.setattr(storage, "_cache_loaded", True)
    yield


def test_stale_save_after_delete_does_not_resurrect():
    """The exact Haik bug: an in-flight run holds the object, the user deletes, the run writes back."""
    wf = storage.save_workflow(p_make())
    in_flight = storage.get_workflow(wf.id)
    assert in_flight is not None

    assert storage.delete_workflow(wf.id) is True

    in_flight.last_run_at = datetime.now(timezone.utc)
    storage.save_workflow(in_flight)

    assert storage.get_workflow(wf.id) is None
    assert [w.id for w in storage.list_workflows()] == []
    import os
    assert not os.path.exists(storage._wf_path(wf.id))


def test_repeated_stale_saves_never_resurrect():
    """It never dies: every later write-back must also bounce, not just the first."""
    wf = storage.save_workflow(p_make())
    stale = storage.get_workflow(wf.id)
    storage.delete_workflow(wf.id)
    for i in range(5):
        stale.next_run_at = datetime.now(timezone.utc)
        storage.save_workflow(stale)
        assert storage.get_workflow(wf.id) is None, f"resurrected on write-back {i + 1}"


def test_record_run_after_delete_does_not_recreate_history():
    """Runs are deleted with the workflow; a late run row must not rebuild an orphan history file."""
    wf = storage.save_workflow(p_make())
    storage.delete_workflow(wf.id)
    storage.record_run(WorkflowRun(workflow_id=wf.id, status="success"))
    assert storage.list_runs(wf.id) == []
    import os
    assert not os.path.exists(storage._runs_path(wf.id))


def test_delete_does_not_block_a_different_workflow():
    """The tombstone is per id: deleting one must not stop anything else being saved."""
    dead = storage.save_workflow(p_make("dead"))
    storage.delete_workflow(dead.id)
    alive = storage.save_workflow(p_make("alive"))
    assert storage.get_workflow(alive.id) is not None
    assert [w.id for w in storage.list_workflows()] == [alive.id]


def test_executor_refuses_a_workflow_that_no_longer_exists():
    """A hard delete makes get_workflow return None, which the pause guard did not treat as refusal,
    so a deleted workflow still ran to completion and then resurrected itself on write-back."""
    from backend.apps.workflows import executor

    wf = storage.save_workflow(p_make())
    storage.delete_workflow(wf.id)

    run = asyncio.run(executor.execute(wf, triggered_by="schedule"))
    assert run.status == "skipped"
    assert "delete" in (run.error or "").lower()
    assert storage.get_workflow(wf.id) is None


def test_disable_schedule_on_a_deleted_workflow_stays_dead():
    """The scheduler disables end-of-life workflows by saving them; on a deleted one that is a
    resurrection with enabled=False, which still shows up on the Workflows page."""
    from backend.apps.workflows import scheduler

    wf = storage.save_workflow(p_make())
    stale = storage.get_workflow(wf.id)
    storage.delete_workflow(wf.id)
    scheduler._disable_schedule(stale)
    assert storage.get_workflow(wf.id) is None
    assert [w.id for w in storage.list_workflows()] == []


def test_a_stale_copy_cannot_untrash_a_workflow():
    """Trash is one-way. reload_workflow hands out a NEW instance, so a run that started before the
    user hit delete can end up holding a copy whose deleted_at is still None; saving that copy put
    the workflow back on the page with its schedule re-armed."""
    wf = storage.save_workflow(p_make())
    stale = storage.get_workflow(wf.id)
    storage.reload_workflow(wf.id)  # the cache now holds a DIFFERENT instance; the run kept `stale`
    trashed = storage.get_workflow(wf.id)
    assert trashed is not stale, "test models nothing unless the two copies really diverged"
    assert stale.deleted_at is None

    trashed.deleted_at = datetime.now()
    trashed.schedule.enabled = False
    storage.save_workflow(trashed)

    stale.last_run_at = datetime.now(timezone.utc)
    storage.save_workflow(stale)

    live = storage.get_workflow(wf.id)
    assert live is not None and live.deleted_at is not None, "a stale copy untrashed it"
    assert live.schedule.enabled is False, "the schedule was re-armed by a stale write-back"


def test_restore_can_still_untrash():
    """The one-way rule must not brick the Trash > Restore button."""
    wf = storage.save_workflow(p_make())
    trashed = storage.get_workflow(wf.id)
    trashed.deleted_at = datetime.now()
    storage.save_workflow(trashed)

    back = storage.reload_workflow(wf.id)
    back.deleted_at = None
    storage.save_workflow(back, untrash=True)
    assert storage.get_workflow(wf.id).deleted_at is None


def test_delete_survives_a_reload_from_disk():
    """reload_workflow re-reads from disk; on a deleted id it must not repopulate the cache."""
    wf = storage.save_workflow(p_make())
    storage.delete_workflow(wf.id)
    assert storage.reload_workflow(wf.id) is None
    assert storage.get_workflow(wf.id) is None
