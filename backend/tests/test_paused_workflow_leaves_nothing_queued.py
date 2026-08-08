"""Switching a workflow off must leave NOTHING queued anywhere.

Eric: "when you pause it it better not be putting ANYTHING anywhere". Trashing already dropped a
workflow's pending missed fires; pausing did not, and neither the review-card list nor its run
endpoint looked at `schedule.enabled` (both only skipped `if not wf`). So a paused workflow kept
appearing on the launch review card, and running it from there reported started=N while the executor
refused every one of them.
"""

from datetime import datetime, timedelta, timezone

import pytest

from backend.apps.workflows import storage
from backend.apps.workflows.models import MissedRun, Workflow, WorkflowStep


def p_make(enabled: bool = True) -> Workflow:
    return Workflow(
        title="nightly",
        steps=[WorkflowStep(text="do it")],
        schedule={"enabled": enabled, "kind": "interval", "every_minutes": 45},
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
    yield


def p_queue_a_miss(wf: Workflow) -> MissedRun:
    m = MissedRun(
        workflow_id=wf.id,
        scheduled_for=datetime.now(timezone.utc) - timedelta(hours=2),
    )
    storage.add_missed(m)
    return m


def test_pausing_clears_the_pending_missed_queue():
    from backend.apps.workflows.workflows import p_drop_pending_missed

    wf = storage.save_workflow(p_make())
    p_queue_a_miss(wf)
    assert [m.workflow_id for m in storage.list_missed()] == [wf.id]

    wf.schedule.enabled = False
    storage.save_workflow(wf)
    p_drop_pending_missed(wf.id)

    assert storage.list_missed() == [], "a switched-off workflow left fires queued"


def test_pausing_one_workflow_leaves_another_alone():
    from backend.apps.workflows.workflows import p_drop_pending_missed

    off = storage.save_workflow(p_make())
    on = storage.save_workflow(p_make())
    p_queue_a_miss(off)
    p_queue_a_miss(on)

    p_drop_pending_missed(off.id)
    assert [m.workflow_id for m in storage.list_missed()] == [on.id]


@pytest.mark.asyncio
async def test_review_card_hides_a_paused_workflows_misses():
    """Belt over the clearing above: entries queued BEFORE this fix shipped must vanish too."""
    from backend.apps.workflows.workflows import list_missed_runs

    wf = storage.save_workflow(p_make())
    p_queue_a_miss(wf)
    assert len((await list_missed_runs())["missed"]) == 1

    wf.schedule.enabled = False
    storage.save_workflow(wf)
    assert (await list_missed_runs())["missed"] == [], "paused workflow still on the review card"


@pytest.mark.asyncio
async def test_review_card_hides_a_trashed_workflows_misses():
    from backend.apps.workflows.workflows import list_missed_runs

    wf = storage.save_workflow(p_make())
    p_queue_a_miss(wf)
    wf.deleted_at = datetime.now()
    storage.save_workflow(wf)
    assert (await list_missed_runs())["missed"] == []


@pytest.mark.asyncio
async def test_running_a_paused_workflows_miss_starts_nothing_and_says_so():
    """It used to report started=N for runs the executor then refused, which is a lie the UI shows."""
    from backend.apps.workflows.workflows import run_missed_runs
    from backend.apps.workflows.models import MissedRunAction

    wf = storage.save_workflow(p_make(enabled=False))
    m = p_queue_a_miss(wf)

    result = await run_missed_runs(MissedRunAction(ids=[m.id]))
    assert result["started"] == 0, "dispatched a run for a switched-off workflow"
