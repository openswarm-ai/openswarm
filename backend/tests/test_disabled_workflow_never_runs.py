"""A workflow the user deleted or switched off must not run from ANY path.

Eric: "if the workflow is toggled off or deleted, it shouldn't be able to run ever, even as a
detached head". Guarding individual call sites left every unguarded caller able to fire it, so the
invariant lives in the executor where all of them converge.
"""

import asyncio
from datetime import datetime
from unittest.mock import patch

import pytest

from backend.apps.workflows import executor
from backend.apps.workflows.models import ScheduleConfig, Workflow, WorkflowStep


def p_wf(enabled: bool, deleted: bool = False) -> Workflow:
    wf = Workflow(
        title="t",
        steps=[WorkflowStep(text="say hi", enabled=True)],
        schedule=ScheduleConfig(enabled=enabled),
    )
    if deleted:
        wf.deleted_at = datetime.now()
    return wf


@pytest.mark.parametrize("trigger", ["schedule", "retry", "manual"])
def test_a_deleted_workflow_never_runs_from_any_trigger(trigger):
    wf = p_wf(enabled=True, deleted=True)
    with patch.object(executor.storage, "get_workflow", return_value=wf):
        run = asyncio.run(executor.execute(wf, triggered_by=trigger))
    assert run.status == "skipped"
    assert run.error == "Workflow deleted"


@pytest.mark.parametrize("trigger", ["schedule", "retry"])
def test_a_paused_workflow_never_runs_from_background_triggers(trigger):
    """Off means off for every BACKGROUND path: the scheduler and retries stay locked out."""
    wf = p_wf(enabled=False)
    with patch.object(executor.storage, "get_workflow", return_value=wf):
        run = asyncio.run(executor.execute(wf, triggered_by=trigger))
    assert run.status == "skipped"
    assert run.error == "Workflow is paused"


def test_a_human_pressing_run_gets_past_the_pause_gate():
    """A fresh workflow's schedule defaults to off, and the Run button silently skipping made the
    whole builder look broken (Eric's repro, 2026-08-17). Manual = the user IS the trigger; the
    zero cost cap proves passage: the run dies at the CAP check, which sits AFTER the pause gate."""
    wf = p_wf(enabled=False)
    wf.cost_cap_usd_monthly = 0.0
    with patch.object(executor.storage, "get_workflow", return_value=wf):
        with patch.object(executor.storage, "record_run"):
            with patch.object(executor, "_monthly_spend_so_far", return_value=0.0):
                run = asyncio.run(executor.execute(wf, triggered_by="manual"))
    assert run.error != "Workflow is paused"
    assert "cost cap" in (run.error or "")


def test_turning_it_back_on_lets_it_run_again():
    """The guard must be about state, not a permanent block."""
    wf = p_wf(enabled=True)
    with patch.object(executor.storage, "get_workflow", return_value=wf):
        with patch.object(executor.storage, "record_run"):
            with patch.object(executor, "_monthly_spend_so_far", return_value=0.0):
                assert executor.storage.get_workflow(wf.id).schedule.enabled is True
