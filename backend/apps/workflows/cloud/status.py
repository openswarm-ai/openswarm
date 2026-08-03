"""What the desktop is allowed to say about cloud runs for one workflow.

Three answers, and they are different answers. `ready` is the cloud having told
us something. `signed_out` is a known no-account. `unknown` is us not knowing,
which is deliberately NOT a denial and carries no numbers at all: a failed fetch
that renders as "0 runs left" or "not entitled" is the bug this shape prevents.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional, Union

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.workflows import storage
from backend.apps.workflows.cloud import client as cloud
from backend.apps.workflows.cloud.credential_readiness import CredentialReadiness, cloud_credential_readiness
from backend.apps.workflows.cloud.definition import cloud_definition, definition_signature
from backend.apps.workflows.cloud.portable_context import portable_context
from backend.apps.workflows.cloud.schedule import ScheduleSupported, to_cloud_schedule, wire
from backend.apps.workflows.models import Workflow


class HostedState(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    id: str
    enabled: bool
    next_run_at: Optional[datetime] = None
    # False when the workflow was edited after we pushed it, so the cloud is running older prose.
    in_sync: bool


class CloudStatusBase(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    target: Literal["device", "cloud"]
    schedule_supported: bool
    schedule_reason: Optional[str] = None


class CloudStatusSignedOut(CloudStatusBase):
    state: Literal["signed_out"] = "signed_out"


class CloudStatusUnknown(CloudStatusBase):
    state: Literal["unknown"] = "unknown"
    detail: str


class CloudStatusReady(CloudStatusBase):
    state: Literal["ready"] = "ready"
    plan: Optional[str] = None
    limits: cloud.CloudLimits
    usage: cloud.CloudUsage
    # None when this control plane cannot tell us whether the runner could do the job.
    capability: Optional[cloud.CloudCapability] = None
    hosted: Optional[HostedState] = None
    # Whether this account owns an AI connection the cloud could sign runs with. Read locally,
    # because it is our 9router db that knows, not the control plane.
    credential: CredentialReadiness


CloudStatus = Union[CloudStatusReady, CloudStatusSignedOut, CloudStatusUnknown]


@typechecked
def epoch_to_datetime(ms: Optional[int]) -> Optional[datetime]:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).astimezone()


@typechecked
def current_signature(wf: Workflow) -> Optional[str]:
    """The fingerprint this workflow would push right now, or None when its
    schedule has no cloud equivalent at all."""
    mapping = to_cloud_schedule(wf.schedule)
    if not isinstance(mapping, ScheduleSupported):
        return None
    # wire() is the richer serializer (weekly, zones, ends_at); portable_context is what the runner needs to reproduce the user's setup.
    return definition_signature(
        cloud_definition(wf), wire(mapping.schedule), portable_context().as_body()
    )


@typechecked
def p_mirror_cloud_state(wf: Workflow, hosted: Optional[cloud.HostedWorkflow]) -> None:
    """Once the cloud holds the timer it also holds the truth about it. The local
    scheduler stops rolling next_run_at for a cloud workflow, so every "next run"
    in the app would sit at a time that has already passed, and an On switch read
    off our own copy would keep saying On for a workflow paused somewhere else."""
    if wf.execution_target != "cloud":
        return
    wanted = epoch_to_datetime(hosted.next_run_at) if hosted and hosted.enabled else None
    changed = wf.next_run_at != wanted
    wf.next_run_at = wanted
    if hosted and wf.schedule.enabled != hosted.enabled:
        wf.schedule.enabled = hosted.enabled
        changed = True
    # Runs the cloud performed count against a max_runs cap the same as ours do, so copy its total
    # back. Without this, taking a nearly-spent schedule off the cloud would restart it at zero.
    if hosted and hosted.runs_done is not None and wf.schedule.runs_count != hosted.runs_done:
        wf.schedule.runs_count = hosted.runs_done
        changed = True
    if changed:
        storage.save_workflow(wf)


@typechecked
async def compute_status(wf: Workflow) -> CloudStatus:
    mapping = to_cloud_schedule(wf.schedule)
    supported = isinstance(mapping, ScheduleSupported)
    shared = {
        "target": wf.execution_target,
        "schedule_supported": supported,
        "schedule_reason": None if isinstance(mapping, ScheduleSupported) else mapping.reason,
    }
    try:
        pre = await cloud.preflight(cloud_definition(wf), wf.cloud_workflow_id)
    except cloud.SignedOut:
        return CloudStatusSignedOut(**shared)
    except cloud.CloudUnreachable as exc:
        return CloudStatusUnknown(detail=exc.detail, **shared)
    except cloud.CloudRefused as exc:
        return CloudStatusUnknown(detail=exc.message, **shared)

    p_mirror_cloud_state(wf, pre.hosted)
    hosted: Optional[HostedState] = None
    if pre.hosted:
        hosted = HostedState(
            id=pre.hosted.id,
            enabled=pre.hosted.enabled,
            next_run_at=epoch_to_datetime(pre.hosted.next_run_at),
            in_sync=wf.cloud_definition_signature is not None
            and wf.cloud_definition_signature == current_signature(wf),
        )
    return CloudStatusReady(
        plan=pre.plan,
        limits=pre.limits,
        usage=pre.usage,
        capability=pre.capability,
        hosted=hosted,
        credential=cloud_credential_readiness(),
        **shared,
    )
