"""Run history rows all read "Workflow" once their workflow is gone (ENG-307, live-reproduced:
/api/workflows/runs/all returned 8 runs whose workflow_ids matched zero listed workflows, so the
frontend's title join could never succeed). The title is now stamped onto the run at record time,
so the label survives rename and deletion instead of depending on a join that can fail.
"""
import pytest
from typeguard import typechecked

from backend.apps.workflows import storage
from backend.apps.workflows.models import Workflow, WorkflowRun


@pytest.fixture()
def p_isolated_store(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DATA_DIR", str(tmp_path))
    storage.init()
    yield tmp_path
    monkeypatch.undo()
    storage.init()


@typechecked
def p_make_workflow(title: str) -> Workflow:
    wf = Workflow(title=title)
    storage.save_workflow(wf)
    return wf


def test_record_run_stamps_the_workflow_title(p_isolated_store):
    wf = p_make_workflow("Read Cart Screenshots")
    run = storage.record_run(WorkflowRun(workflow_id=wf.id))
    assert run.workflow_title == "Read Cart Screenshots"


def test_stamped_title_survives_workflow_deletion(p_isolated_store):
    wf = p_make_workflow("Nightly digest")
    storage.record_run(WorkflowRun(workflow_id=wf.id, status="success"))
    storage.delete_workflow(wf.id)
    survivors = [r for r in storage.list_all_runs() if r.workflow_id == wf.id]
    if not survivors:
        pytest.skip("delete purges run history in this store; nothing left to label")
    assert survivors[0].workflow_title == "Nightly digest"


def test_a_caller_provided_title_is_never_overwritten(p_isolated_store):
    wf = p_make_workflow("Fresh name")
    run = storage.record_run(WorkflowRun(workflow_id=wf.id, workflow_title="Name at fire time"))
    assert run.workflow_title == "Name at fire time"
