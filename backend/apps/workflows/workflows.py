import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from fastapi import HTTPException

from backend.config.Apps import SubApp
from backend.apps.workflows.models import (
    Workflow,
    WorkflowCreate,
    WorkflowUpdate,
    WorkflowRun,
)
from backend.apps.workflows import storage, scheduler, executor

logger = logging.getLogger(__name__)


@asynccontextmanager
async def workflows_lifespan():
    storage.init()
    await scheduler.start()
    try:
        yield
    finally:
        await scheduler.stop()


workflows = SubApp("workflows", workflows_lifespan)


def _derive_icon(wf: Workflow) -> str:
    """Cheap icon hint used until proper auto-icon generation lands.

    Pull the first emoji from the title, falling back to the first
    letter. Keeps the Search list (image 2 annotation) populated without
    waiting on the LLM-based icon generator.
    """
    title = (wf.title or "").strip()
    for ch in title:
        if ord(ch) > 0x2700:
            return ch
    if title:
        return title[:1].upper()
    return "W"


@workflows.router.get("/list")
async def list_workflows(dashboard_id: Optional[str] = None):
    items = storage.list_workflows()
    if dashboard_id:
        items = [w for w in items if not w.dashboard_id or w.dashboard_id == dashboard_id]
    items.sort(key=lambda w: w.updated_at or w.created_at, reverse=True)
    return {"workflows": [w.model_dump(mode="json") for w in items]}


@workflows.router.post("/create")
async def create_workflow(body: WorkflowCreate):
    wf = Workflow(
        title=body.title,
        description=body.description,
        icon=body.icon,
        system_prompt=body.system_prompt,
        use_synced_prompt=body.use_synced_prompt,
        steps=body.steps,
        actions=body.actions,
        schedule=body.schedule,
        permissions=body.permissions or [],
        source_session_id=body.source_session_id,
        dashboard_id=body.dashboard_id,
        model=body.model or "sonnet",
        mode=body.mode or "agent",
        provider=body.provider or "anthropic",
    )
    if not wf.icon:
        wf.icon = _derive_icon(wf)
    if wf.schedule.enabled:
        wf.next_run_at = scheduler.compute_next_fire(wf)
    storage.save_workflow(wf)
    scheduler.kick()
    return wf.model_dump(mode="json")


@workflows.router.get("/{workflow_id}")
async def get_workflow(workflow_id: str):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return wf.model_dump(mode="json")


@workflows.router.patch("/{workflow_id}")
async def update_workflow(workflow_id: str, body: WorkflowUpdate):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(wf, k, v)
    wf.updated_at = datetime.now()
    if not wf.icon:
        wf.icon = _derive_icon(wf)
    wf.next_run_at = scheduler.compute_next_fire(wf) if wf.schedule.enabled else None
    storage.save_workflow(wf)
    scheduler.kick()
    return wf.model_dump(mode="json")


@workflows.router.delete("/{workflow_id}")
async def delete_workflow(workflow_id: str):
    existed = storage.delete_workflow(workflow_id)
    if not existed:
        raise HTTPException(status_code=404, detail="Workflow not found")
    scheduler.kick()
    return {"ok": True}


@workflows.router.post("/{workflow_id}/run")
async def run_workflow_now(workflow_id: str):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    # executor.execute() owns the run record. Don't pre-create a stub here
    # or we end up with two rows per manual fire (one orphan "running"
    # row from this handler plus the real one from the executor).
    pre_ids = {r.id for r in storage.list_runs(wf.id, limit=10)}
    asyncio.create_task(executor.execute(wf, triggered_by="manual"))

    # Poll briefly for the newly created run id (anything not already in
    # the pre-fire snapshot). Falls back to empty if the executor hasn't
    # written within 250ms — frontend reconciles via WS afterwards.
    for _ in range(25):
        for r in storage.list_runs(wf.id, limit=10):
            if r.id not in pre_ids and r.triggered_by == "manual":
                return {"run_id": r.id}
        await asyncio.sleep(0.01)
    return {"run_id": ""}


@workflows.router.get("/{workflow_id}/runs")
async def list_workflow_runs(workflow_id: str, limit: int = 50):
    wf = storage.get_workflow(workflow_id)
    if not wf:
        raise HTTPException(status_code=404, detail="Workflow not found")
    runs = storage.list_runs(workflow_id, limit=limit)
    return {"runs": [r.model_dump(mode="json") for r in runs]}
