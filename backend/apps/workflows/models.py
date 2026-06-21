from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
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
    # be able to crash _next_fire_after by passing hour=99. The per-unit
    # upper bound on repeat_every is clamped (not rejected) in
    # _enforce_interval_bounds below, so only the floor lives on the Field.
    repeat_every: int = Field(default=1, ge=1)
    repeat_unit: Literal["minute", "hour", "day", "week", "month"] = "week"
    on_days: list[int] = Field(default_factory=list)
    hour: int = Field(default=9, ge=0, le=23)
    minute: int = Field(default=0, ge=0, le=59)
    # Monthly schedules can pin a day-of-month explicitly. None preserves the
    # legacy "same day as the current reference" behavior for older records.
    day_of_month: Optional[int] = Field(default=None, ge=1, le=31)
    # IANA zone name (e.g. "America/Los_Angeles") or "local" for legacy
    # records that predate explicit tz. storage._load_all_from_disk coerces
    # "local" to the host zone in memory; we leave it on disk until the
    # user's next save so backup/sync tools don't see spurious churn.
    timezone: str = "local"
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

    @model_validator(mode="after")
    def _enforce_interval_bounds(self) -> "ScheduleConfig":
        # Per-unit bounds, clamped rather than rejected so a stray value from
        # an agent tool or old record can't crash the scheduler. The minute
        # unit floors at 15 (no once-a-minute token-burning loop) and ceilings
        # at 1440 (24h); every other unit keeps the original 365 ceiling.
        if self.repeat_unit == "minute":
            self.repeat_every = max(15, min(self.repeat_every, 1440))
        else:
            self.repeat_every = min(self.repeat_every, 365)
        return self


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
    # Tool names observed in the source chat when this workflow was generated.
    # This preserves conversion context without pretending those calls map to
    # generated workflow step ids. Explicit approval decisions still live in
    # remembered_approvals and are the only values reused as permissions.
    source_tools: list[str] = Field(default_factory=list)
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
    # Sticky session id for the embedded scheduling agent (the chat that
    # turns "every Wednesday at 1pm" into a permission-gated tool call).
    schedule_agent_session_id: Optional[str] = None
    # Pending Edit-Agent draft of the steps. None = no draft in flight. Edits
    # stage here and only land on `steps` when the user clicks Save; scheduled
    # runs read `steps`, so a pending draft never affects a fire.
    draft_steps: Optional[list[WorkflowStep]] = None
    # Most recent Test Agent session for this workflow; read by ReadTestTranscript.
    last_test_session_id: Optional[str] = None
    # Tool permissions the user answered once and we reuse on later runs so an
    # unattended scheduled fire doesn't stall waiting for someone to click.
    # tool_name -> decision. Only ordinary "ask" tools land here; sensitive
    # paths keep their own per-pattern trust and never auto-remember.
    remembered_approvals: dict[str, Literal["allow", "deny"]] = Field(default_factory=dict)
    # Behind-the-scenes record of which tools each step touched and whether each
    # was permitted, keyed by stable step id (not index, so reorders don't
    # scramble it). Auto-maintained on runs; enforcement stays workflow-level
    # via remembered_approvals, this is the finer per-step picture.
    step_tool_usage: dict[str, dict[str, bool]] = Field(default_factory=dict)
    # False once the user explicitly sets a title; True means the backend may
    # overwrite the title via auto-naming when steps are added/changed.
    auto_named: bool = False
    # True for a brand-new "+ New" workflow that the user is still building in
    # the Edit Agent and hasn't saved yet. The Workflows hub hides these from
    # the scheduled/unscheduled lists until the first commit clears the flag,
    # so an in-progress build doesn't litter the sidebar.
    unsaved: bool = False
    # Stable signature of the steps last validated by a test run (or seeded at
    # chat conversion). The FE compares it against the current steps before
    # scheduling: a mismatch means "edited since you last approved tools" and
    # triggers the test-first warning. Computed FE-side so there's one algorithm.
    tested_signature: Optional[str] = None


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
    # True while the user has paused the in-flight agent turn (same mechanic
    # as the chat's stop/resume). Rides the workflow:run broadcast so the
    # card shows the paused state even when the live chat isn't open.
    paused: bool = False


class MissedRun(BaseModel):
    # A single scheduled fire that elapsed while OpenSwarm was closed. Captured
    # at startup and surfaced in the launch-time review card; leaves this store
    # only when the user runs it (becomes a ran_late run) or dismisses it
    # (becomes a skipped run). scheduled_for is the instant it should have fired.
    id: str = Field(default_factory=lambda: uuid4().hex)
    workflow_id: str
    scheduled_for: datetime
    created_at: datetime = Field(default_factory=datetime.now)


class WorkflowCreate(BaseModel):
    title: str = "Untitled workflow"
    auto_named: bool = True
    # Only the "+ New" build flow sets this; every other create path is a
    # deliberate save and stays visible immediately.
    unsaved: bool = False
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
    tested_signature: Optional[str] = None
    # The FE already named + described + labeled this at preview time; skip the
    # backend aux call so we don't double-spend or change the title under the user.
    metadata_generated: bool = False


class GenerateMetadataRequest(BaseModel):
    steps: list[WorkflowStep] = Field(default_factory=list)
    model: Optional[str] = None


class GenerateMetadataResponse(BaseModel):
    title: str = ""
    description: str = ""
    step_labels: list[str] = Field(default_factory=list)


class WorkflowUpdate(BaseModel):
    title: Optional[str] = None
    auto_named: Optional[bool] = None
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
    remembered_approvals: Optional[dict[str, Literal["allow", "deny"]]] = None
    step_tool_usage: Optional[dict[str, dict[str, bool]]] = None


class MissedRunAction(BaseModel):
    ids: list[str] = Field(default_factory=list)


class DraftCommitBody(BaseModel):
    # The model the user settled on in the Edit Agent picker, applied to the
    # workflow's run model only on Save (save-gated; Discard drops it).
    model: Optional[str] = None
