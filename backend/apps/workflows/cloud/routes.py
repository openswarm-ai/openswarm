"""HTTP surface for running a workflow on our servers instead of this machine.

Its own SubApp so the already-large workflows.py does not grow. Prefix:
/api/cloud_workflows. The local half of the handover (which timer is armed)
lives in cloud/handover.py; nothing here is the authority on entitlement, the
cloud re-decides that at create and again at dispatch.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from typing import List, Literal, Optional, Union

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.workflows import storage
from backend.apps.nine_router.lent_credential_refresh import lent_credential_loop
from backend.apps.workflows.cloud import client as cloud
from backend.apps.workflows.cloud.handover import TargetOutcome, hand_to_cloud, take_back
from backend.apps.workflows.cloud.run_files import LocalRunFile, described, downloads_root, fetch_missing
from backend.apps.workflows.cloud.status import CloudStatus, compute_status, epoch_to_datetime
from backend.apps.workflows.models import Workflow
from backend.config.Apps import SubApp


@asynccontextmanager
async def cloud_workflows_lifespan():
    # Lending a credential upward strips this device's ability to renew it, so something has to
    # ask the cloud for a fresh one before the old one dies. Without this, turning on a cloud
    # workflow quietly stops local agents a few hours later.
    task = asyncio.create_task(lent_credential_loop())
    try:
        yield
    finally:
        task.cancel()


cloud_workflows = SubApp("cloud_workflows", cloud_workflows_lifespan)


class TargetRequest(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    # The whole desired state, not a delta: where the schedule runs and whether it runs at all.
    target: Literal["device", "cloud"]
    enabled: bool


class CloudRunRow(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    id: str
    status: str
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    error: Optional[str] = None
    answer: Optional[str] = None
    notices: List[str] = []
    cost_usd: Optional[float] = None
    files: List[LocalRunFile] = []


class CloudRunsReady(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    state: Literal["ready"] = "ready"
    runs: List[CloudRunRow] = []
    # Where this machine puts a cloud run's files, so the UI can say it out loud even when a run
    # has none yet. A folder the user is told about is a folder they can find later.
    files_folder: str = ""


class CloudRunsUnavailable(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    # Same rule as the status route: not knowing is its own answer, and it shows no runs rather than "no runs".
    state: Literal["signed_out", "unknown"]
    detail: Optional[str] = None


CloudRunsResponse = Union[CloudRunsReady, CloudRunsUnavailable]


@typechecked
def p_workflow(workflow_id: str) -> Workflow:
    wf = storage.get_workflow(workflow_id)
    if not wf or wf.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return wf


@cloud_workflows.router.get("/{workflow_id}/status")
async def workflow_cloud_status(workflow_id: str) -> CloudStatus:
    return await compute_status(p_workflow(workflow_id))


@cloud_workflows.router.post("/{workflow_id}/target")
async def set_workflow_target(workflow_id: str, body: TargetRequest) -> TargetOutcome:
    wf = p_workflow(workflow_id)
    if body.target == "cloud":
        return await hand_to_cloud(wf, body.enabled)
    return await take_back(wf, body.enabled)


@cloud_workflows.router.get("/{workflow_id}/runs")
async def workflow_cloud_runs(workflow_id: str) -> CloudRunsResponse:
    wf = p_workflow(workflow_id)
    if not wf.cloud_workflow_id:
        return CloudRunsReady(runs=[], files_folder=downloads_root())
    try:
        runs = await cloud.list_runs(wf.cloud_workflow_id)
    except cloud.SignedOut:
        return CloudRunsUnavailable(state="signed_out")
    except cloud.CloudRefused as exc:
        # A 404 here is the hosted copy being gone, which is an empty history, not a broken one.
        if exc.status == 404:
            return CloudRunsReady(runs=[], files_folder=downloads_root())
        return CloudRunsUnavailable(state="unknown", detail=exc.message)
    except cloud.CloudUnreachable as exc:
        return CloudRunsUnavailable(state="unknown", detail=exc.detail)

    # Answered now, files fetched behind it. A 20MB attachment must not hold up the history the
    # user asked for, and a run's files appear a moment later without them doing anything.
    asyncio.create_task(fetch_missing(wf.cloud_workflow_id, wf, runs))

    return CloudRunsReady(
        files_folder=downloads_root(),
        runs=[
            CloudRunRow(
                id=r.id,
                status=r.status,
                started_at=epoch_to_datetime(r.started_at),
                finished_at=epoch_to_datetime(r.finished_at),
                error=r.error,
                answer=r.answer,
                notices=r.notices,
                cost_usd=r.cost_usd,
                files=described(wf, r),
            )
            for r in runs
        ],
    )
