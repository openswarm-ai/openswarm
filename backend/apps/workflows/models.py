from pydantic import BaseModel, ConfigDict, Field, field_validator
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
    # Bounds keep the scheduler from blowing up on malformed input. The
    # FE clamps these too, but defense-in-depth: a misbehaving agent
    # tool, an old JSON file, or a curl-wielding power user shouldn't
    # be able to crash _next_fire_after by passing hour=99.
    repeat_every: int = Field(default=1, ge=1, le=365)
    repeat_unit: Literal["day", "week", "month"] = "week"
    on_days: list[int] = Field(default_factory=list)
    hour: int = Field(default=9, ge=0, le=23)
    minute: int = Field(default=0, ge=0, le=59)
    # IANA zone name (e.g. "America/Los_Angeles") or "local" for legacy
    # records that predate explicit tz. storage._load_all_from_disk coerces
    # "local" to the host zone in memory; we leave it on disk until the
    # user's next save so backup/sync tools don't see spurious churn.
    timezone: str = "local"
    on_missed: Literal["skip", "run_once", "run_all"] = "skip"
    # Optional end conditions. None = forever / unbounded. Schedule auto-
    # disables once either is satisfied; scheduler._tick zeroes out
    # next_run_at and flips enabled=False so the UI reflects reality.
    ends_at: Optional[datetime] = None
    max_runs: Optional[int] = Field(default=None, ge=1)
    runs_count: int = Field(default=0, ge=0)

    @field_validator("on_days")
    @classmethod
    def _clean_on_days(cls, v: list[int]) -> list[int]:
        # Backend uses JS-style weekday (Sun=0..Sat=6). Drop entries
        # outside that range so a malformed PATCH can't trip the
        # scheduler later, and dedupe while preserving order.
        seen: set[int] = set()
        out: list[int] = []
        for d in v or []:
            if isinstance(d, int) and 0 <= d <= 6 and d not in seen:
                seen.add(d)
                out.append(d)
        return out


class ActionsConfig(BaseModel):
    prevent_unused: bool = False
    freeze: bool = False
    configured_sets: list[str] = Field(default_factory=list)


class WorkflowStep(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    text: str = ""
    # 3 to 6 word LLM-generated headline shown in the collapsed step row.
    # The full prompt lives in `text`; this is the "at-a-glance" label.
    label: Optional[str] = None


def _empty_str_default() -> str:
    return ""


class Workflow(BaseModel):
    # validate_assignment is load-bearing for the PATCH /workflows/{id} path
    # (workflows.py:update_workflow setattr's raw dicts from body.model_dump
    # straight onto the cached Workflow). Without coercion the nested
    # schedule/steps/actions/permissions fields become plain dicts in
    # memory, and every downstream call; scheduler tick, executor.execute,
    # subsequent PATCHes; crashes on `.enabled` / `.text`.
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
    last_run_status: Optional[Literal["success", "failure", "ran_late", "running", "skipped"]] = None
    last_run_id: Optional[str] = None
    next_run_at: Optional[datetime] = None
    cost_cap_usd_monthly: Optional[float] = None
    # Sticky session id for the Edit Agent embedded in the workflow card
    # (Image #38, #48). Optional so older workflows don't fail validation
    # on rehydrate.
    edit_agent_session_id: Optional[str] = None


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
    # Last tool-call label observed on the underlying agent session while
    # the workflow is running. Surfaced under the active step in RunningView
    # (Image #40) so the user can tell the run is still making progress.
    last_tool_label: Optional[str] = None
    # Currently-executing step index (0-based). Executor bumps this each
    # time it dispatches a step prompt and broadcasts the run. RunningView
    # uses this for the disc statuses; estimate fallback only when null.
    active_step_idx: Optional[int] = None


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
    cost_cap_usd_monthly: Optional[float] = None


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
    cost_cap_usd_monthly: Optional[float] = None
