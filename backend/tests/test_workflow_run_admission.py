"""No stampede: a due fire beyond the global cap queues, and gives up honestly, never silently.

Every workflow run is a full agent, and a working agent's browsers and apps are exempt from the
renderer budget on purpose (sleeping them blinds the agent). So the ONLY bound on total pressure is
how many runs exist at once, and before this the scheduler would happily start one agent per due
workflow: thirty accumulated workflows drifting into schedule alignment meant thirty agents.
"""

import asyncio

import pytest

from backend.apps.workflows import executor, storage
from backend.apps.workflows.models import Workflow, WorkflowStep


def p_make() -> Workflow:
    return Workflow(
        title="queued",
        steps=[WorkflowStep(text="do it")],
        schedule={"enabled": True, "kind": "interval", "every_minutes": 45},
    )


@pytest.fixture(autouse=True)
def p_isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", str(tmp_path / "workflows"))
    monkeypatch.setattr(storage, "RUNS_DIR", str(tmp_path / "workflows" / "runs"))
    monkeypatch.setattr(storage, "PAUSED_FILE", str(tmp_path / "workflows" / "paused.json"))
    monkeypatch.setattr(storage, "MISSED_FILE", str(tmp_path / "workflows" / "missed.json"))
    monkeypatch.setattr(storage, "_workflow_cache", {})
    monkeypatch.setattr(storage, "_runs_cache", {})
    monkeypatch.setattr(storage, "_missed_cache", [])
    monkeypatch.setattr(storage, "p_deleted_ids", set(), raising=False)
    monkeypatch.setattr(storage, "_cache_loaded", True)
    monkeypatch.setattr(executor, "_running", {})
    yield


def test_at_the_cap_a_fire_waits_then_skips_with_an_honest_row(monkeypatch):
    monkeypatch.setattr(executor, "MAX_CONCURRENT_RUNS", 2)
    monkeypatch.setattr(executor, "ADMISSION_WAIT_S", 0.05)
    monkeypatch.setattr(executor, "ADMISSION_POLL_S", 0.01)
    monkeypatch.setattr(executor, "_running", {"other-a": "r1", "other-b": "r2"})

    wf = storage.save_workflow(p_make())
    run = asyncio.run(executor.execute(wf, triggered_by="schedule"))

    assert run.status == "skipped"
    assert "already running" in (run.error or "")
    rows = storage.list_runs(wf.id)
    assert len(rows) == 1 and rows[0].status == "skipped", "the give-up must be visible in History"


def test_a_freed_slot_lets_the_queued_fire_proceed(monkeypatch):
    """The wait is a queue, not a rejection: the moment a slot frees, the run goes ahead and reaches
    the normal guard path (here: refused as paused, which proves it got past admission)."""
    monkeypatch.setattr(executor, "MAX_CONCURRENT_RUNS", 1)
    monkeypatch.setattr(executor, "ADMISSION_WAIT_S", 5.0)
    monkeypatch.setattr(executor, "ADMISSION_POLL_S", 0.01)
    monkeypatch.setattr(executor, "_running", {"other-a": "r1"})

    wf = storage.save_workflow(p_make())
    live = storage.get_workflow(wf.id)
    live.schedule.enabled = False
    storage.save_workflow(live)

    async def scenario():
        async def free_slot_soon():
            await asyncio.sleep(0.05)
            executor._running.clear()
        asyncio.ensure_future(free_slot_soon())
        return await executor.execute(wf, triggered_by="schedule")

    run = asyncio.run(scenario())
    assert run.status == "skipped"
    assert "paused" in (run.error or "").lower(), (
        f"expected the post-wait guard to refuse the paused workflow, got {run.error!r}"
    )


def test_the_guard_runs_on_state_AFTER_the_wait(monkeypatch):
    """A workflow deleted while queueing must be refused, not run: admission sits before the
    off-means-off guard precisely so the guard sees post-wait truth."""
    monkeypatch.setattr(executor, "MAX_CONCURRENT_RUNS", 1)
    monkeypatch.setattr(executor, "ADMISSION_WAIT_S", 5.0)
    monkeypatch.setattr(executor, "ADMISSION_POLL_S", 0.01)
    monkeypatch.setattr(executor, "_running", {"other-a": "r1"})

    wf = storage.save_workflow(p_make())

    async def scenario():
        async def delete_then_free():
            await asyncio.sleep(0.05)
            storage.delete_workflow(wf.id)
            executor._running.clear()
        asyncio.ensure_future(delete_then_free())
        return await executor.execute(wf, triggered_by="schedule")

    run = asyncio.run(scenario())
    assert run.status == "skipped"
    assert "delete" in (run.error or "").lower()
