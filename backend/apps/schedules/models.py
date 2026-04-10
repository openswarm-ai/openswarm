from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from uuid import uuid4


class Schedule(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str = "Untitled Schedule"
    enabled: bool = True
    dashboard_id: str

    # Trigger
    trigger_type: str  # "cron" | "interval" | "once"
    cron_expression: Optional[str] = None
    interval_seconds: Optional[int] = None
    run_at: Optional[datetime] = None

    # Action
    action_type: str  # "new_session" | "message_existing"
    prompt: str
    target_session_id: Optional[str] = None

    # Agent config (new_session only)
    template_id: Optional[str] = None
    model: Optional[str] = None
    mode: Optional[str] = None
    system_prompt: Optional[str] = None

    # State
    last_run_at: Optional[datetime] = None
    next_run_at: Optional[datetime] = None
    run_count: int = 0
    last_error: Optional[str] = None

    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)


class ScheduleCreate(BaseModel):
    name: str = "Untitled Schedule"
    dashboard_id: str
    trigger_type: str
    cron_expression: Optional[str] = None
    interval_seconds: Optional[int] = None
    run_at: Optional[datetime] = None
    action_type: str
    prompt: str
    target_session_id: Optional[str] = None
    template_id: Optional[str] = None
    model: Optional[str] = None
    mode: Optional[str] = None
    system_prompt: Optional[str] = None


class ScheduleUpdate(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    dashboard_id: Optional[str] = None
    trigger_type: Optional[str] = None
    cron_expression: Optional[str] = None
    interval_seconds: Optional[int] = None
    run_at: Optional[datetime] = None
    action_type: Optional[str] = None
    prompt: Optional[str] = None
    target_session_id: Optional[str] = None
    template_id: Optional[str] = None
    model: Optional[str] = None
    mode: Optional[str] = None
    system_prompt: Optional[str] = None
