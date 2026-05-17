from pydantic import BaseModel, ConfigDict, Field
from typing import Optional, Literal, Any
from datetime import datetime
from uuid import uuid4


# Each "tier" in the permission chain: notify in app, fall through to text
# after N minutes if no response, then to call after a further N minutes/hours.
# Matches images 17 to 19 (Schedule edit). Order in the list = escalation order.
class PermissionTier(BaseModel):
    kind: Literal["notify", "text", "call"] = "notify"
    after_minutes: int = 0
    phone: Optional[str] = None


class ScheduleConfig(BaseModel):
    enabled: bool = False
    repeat_every: int = 1
    repeat_unit: Literal["day", "week", "month"] = "week"
    on_days: list[int] = Field(default_factory=list)
    hour: int = 9
    minute: int = 0
    timezone: str = "local"
    on_missed: Literal["skip", "run_once", "run_all"] = "skip"


class ActionsConfig(BaseModel):
    prevent_unused: bool = False
    freeze: bool = False
    configured_sets: list[str] = Field(default_factory=list)


class WorkflowStep(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    text: str = ""


class Workflow(BaseModel):
    # validate_assignment is load-bearing for the PATCH /workflows/{id} path
    # (workflows.py:update_workflow setattr's raw dicts from body.model_dump
    # straight onto the cached Workflow). Without coercion the nested
    # schedule/steps/actions/permissions fields become plain dicts in
    # memory, and every downstream call — scheduler tick, executor.execute,
    # subsequent PATCHes — crashes on `.enabled` / `.text`.
    model_config = ConfigDict(validate_assignment=True)

    id: str = Field(default_factory=lambda: uuid4().hex)
    title: str = "Untitled workflow"
    description: str = ""
    icon: str = ""
    system_prompt: Optional[str] = None
    use_synced_prompt: bool = True
    steps: list[WorkflowStep] = Field(default_factory=list)
    actions: ActionsConfig = Field(default_factory=ActionsConfig)
    schedule: ScheduleConfig = Field(default_factory=ScheduleConfig)
    permissions: list[PermissionTier] = Field(
        default_factory=lambda: [PermissionTier(kind="notify")]
    )
    source_session_id: Optional[str] = None
    dashboard_id: Optional[str] = None
    model: str = "sonnet"
    mode: str = "agent"
    provider: str = "anthropic"
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
    last_run_at: Optional[datetime] = None
    last_run_status: Optional[Literal["success", "failure", "ran_late", "running"]] = None
    last_run_id: Optional[str] = None
    next_run_at: Optional[datetime] = None


class WorkflowRun(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    workflow_id: str
    status: Literal["running", "success", "failure", "ran_late", "skipped"] = "running"
    scheduled_for: Optional[datetime] = None
    started_at: datetime = Field(default_factory=datetime.now)
    finished_at: Optional[datetime] = None
    session_id: Optional[str] = None
    error: Optional[str] = None
    cost_usd: float = 0.0
    triggered_by: Literal["schedule", "manual", "retry"] = "schedule"


class WorkflowCreate(BaseModel):
    title: str = "Untitled workflow"
    description: str = ""
    icon: str = ""
    system_prompt: Optional[str] = None
    use_synced_prompt: bool = True
    steps: list[WorkflowStep] = Field(default_factory=list)
    actions: ActionsConfig = Field(default_factory=ActionsConfig)
    schedule: ScheduleConfig = Field(default_factory=ScheduleConfig)
    permissions: Optional[list[PermissionTier]] = None
    source_session_id: Optional[str] = None
    dashboard_id: Optional[str] = None
    model: Optional[str] = None
    mode: Optional[str] = None
    provider: Optional[str] = None


class WorkflowUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    system_prompt: Optional[str] = None
    use_synced_prompt: Optional[bool] = None
    steps: Optional[list[WorkflowStep]] = None
    actions: Optional[ActionsConfig] = None
    schedule: Optional[ScheduleConfig] = None
    permissions: Optional[list[PermissionTier]] = None
    model: Optional[str] = None
    mode: Optional[str] = None
    provider: Optional[str] = None
