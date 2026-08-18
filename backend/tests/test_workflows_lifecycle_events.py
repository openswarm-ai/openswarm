from __future__ import annotations

import asyncio
from datetime import datetime

import pytest


def p_run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def p_workflow_state(isolated_workflows_data, reset_scheduler_state):
    yield


@pytest.fixture
def recorded_events():
    from backend.apps.workflows import lifecycle_events

    events: list[tuple[str, dict]] = []

    async def record(event: str, payload: dict) -> None:
        events.append((event, payload))

    return events, lifecycle_events.BroadcastWorkflowLifecycleEvents(record)


def test_crud_lifecycle_events_preserve_names_and_payloads(
    make_wf, monkeypatch, recorded_events
):
    from backend.apps.workflows import storage
    from backend.apps.workflows.models import (
        WorkflowCreate,
        WorkflowStep,
        WorkflowUpdate,
    )
    from backend.apps.workflows import workflows as routes

    events, event_publisher = recorded_events

    created = p_run(
        routes.create_workflow(
            WorkflowCreate(
                title="Lifecycle",
                steps=[WorkflowStep(text="first")],
                metadata_generated=True,
            ),
            event_publisher=event_publisher,
        )
    )
    workflow_id = created["id"]

    updated = p_run(
        routes.update_workflow(
            workflow_id,
            WorkflowUpdate(description="live update"),
            if_match=None,
            event_publisher=event_publisher,
        )
    )

    workflow = storage.get_workflow(workflow_id)
    workflow.draft_steps = list(workflow.steps)
    storage.save_workflow(workflow)

    async def no_relabel(*args, **kwargs) -> None:
        return None

    monkeypatch.setattr(routes, "p_relabel_steps", no_relabel)
    draft_updated = p_run(
        routes.update_workflow(
            workflow_id,
            WorkflowUpdate(steps=[WorkflowStep(text="draft update")]),
            if_match=None,
            event_publisher=event_publisher,
        )
    )

    assert p_run(routes.delete_workflow(workflow_id, event_publisher)) == {"ok": True}
    restored = p_run(routes.restore_workflow(workflow_id, event_publisher))

    purged_workflow = make_wf(title="Purge")
    purged_workflow.deleted_at = datetime.now()
    storage.save_workflow(purged_workflow)
    assert p_run(routes.purge_workflow(purged_workflow.id, event_publisher)) == {
        "ok": True
    }

    assert events == [
        ("workflow:updated", {"workflow_id": workflow_id, "workflow": created}),
        ("workflow:updated", {"workflow_id": workflow_id, "workflow": updated}),
        ("workflow:updated", {"workflow_id": workflow_id, "workflow": draft_updated}),
        ("workflow:deleted", {"workflow_id": workflow_id}),
        ("workflow:updated", {"workflow_id": workflow_id, "workflow": restored}),
        ("workflow:deleted", {"workflow_id": purged_workflow.id}),
    ]


def test_draft_lifecycle_events_preserve_names_and_payloads(
    make_wf, monkeypatch, recorded_events
):
    from backend.apps.workflows import storage
    from backend.apps.workflows.models import WorkflowStep
    from backend.apps.workflows import workflows as routes

    events, event_publisher = recorded_events

    committed_workflow = make_wf(title="Commit")
    committed_workflow.draft_steps = [WorkflowStep(text="changed")]
    storage.save_workflow(committed_workflow)

    discarded_workflow = make_wf(title="Discard")
    discarded_workflow.draft_steps = [WorkflowStep(text="throw away")]
    storage.save_workflow(discarded_workflow)

    async def no_relabel(*args, **kwargs) -> None:
        return None

    monkeypatch.setattr(routes, "p_relabel_changed_steps", no_relabel)
    committed = p_run(
        routes.commit_draft(
            committed_workflow.id,
            event_publisher=event_publisher,
        )
    )
    discarded = p_run(routes.discard_draft(discarded_workflow.id, event_publisher))

    assert events == [
        (
            "workflow:updated",
            {"workflow_id": committed_workflow.id, "workflow": committed},
        ),
        (
            "workflow:updated",
            {"workflow_id": discarded_workflow.id, "workflow": discarded},
        ),
    ]


@pytest.mark.parametrize("operation", ["updated", "deleted"])
def test_lifecycle_event_failure_does_not_fail_mutation(operation, make_wf):
    from backend.apps.workflows import lifecycle_events, storage
    from backend.apps.workflows.models import WorkflowCreate, WorkflowStep
    from backend.apps.workflows import workflows as routes

    async def fail(*args, **kwargs) -> None:
        raise RuntimeError("fan-out unavailable")

    event_publisher = lifecycle_events.BroadcastWorkflowLifecycleEvents(fail)
    if operation == "updated":
        result = p_run(
            routes.create_workflow(
                WorkflowCreate(
                    title="Still created",
                    steps=[WorkflowStep(text="first")],
                    metadata_generated=True,
                ),
                event_publisher=event_publisher,
            )
        )
        assert storage.get_workflow(result["id"]) is not None
    else:
        workflow = make_wf()
        storage.save_workflow(workflow)
        assert p_run(routes.delete_workflow(workflow.id, event_publisher)) == {
            "ok": True
        }
        assert storage.get_workflow(workflow.id).deleted_at is not None


def test_direct_call_without_injected_publisher_still_broadcasts(monkeypatch):
    from backend.apps.agents.core.ws_manager import ws_manager
    from backend.apps.workflows.models import WorkflowCreate, WorkflowStep
    from backend.apps.workflows import workflows as routes

    events: list[tuple[str, dict]] = []

    async def record(event: str, payload: dict) -> None:
        events.append((event, payload))

    monkeypatch.setattr(ws_manager, "broadcast_global", record)
    created = p_run(
        routes.create_workflow(
            WorkflowCreate(
                title="Direct",
                steps=[WorkflowStep(text="first")],
                metadata_generated=True,
            )
        )
    )

    assert events == [
        (
            "workflow:updated",
            {"workflow_id": created["id"], "workflow": created},
        )
    ]


def test_mutation_routes_inject_lifecycle_event_publisher():
    from backend.apps.workflows import lifecycle_events
    from backend.apps.workflows import workflows as routes

    mutation_endpoints = {
        routes.create_workflow,
        routes.update_workflow,
        routes.delete_workflow,
        routes.restore_workflow,
        routes.purge_workflow,
        routes.commit_draft,
        routes.discard_draft,
    }
    registered = {
        route.endpoint: route
        for route in routes.workflows.router.routes
        if route.endpoint in mutation_endpoints
    }

    assert registered.keys() == mutation_endpoints
    for route in registered.values():
        assert [dependency.call for dependency in route.dependant.dependencies] == [
            lifecycle_events.workflow_lifecycle_event_publisher
        ]
