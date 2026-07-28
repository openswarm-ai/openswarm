"""Models for pattern mining: a WorkflowSuggestion is a repeated behavior we
found in the user's own session history, with the evidence to prove it and a
ready-to-create workflow proposal attached."""

from datetime import datetime
from typing import Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


class SuggestionCadence(BaseModel):
    # Computed IN CODE from evidence timestamps, never trusted from the aux model.
    kind: Literal["weekly", "daily", "irregular"] = "irregular"
    on_days: list[int] = Field(default_factory=list)
    hour: int = 9


class WorkflowSuggestion(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    id: str = Field(default_factory=lambda: uuid4().hex)
    status: Literal["pending", "accepted", "dismissed"] = "pending"
    # One plain second-person sentence: "You often ask for a summary of ...".
    description: str
    # Normalized keyword signature; a dismissed signature is never re-offered.
    signature: str
    evidence_session_ids: list[str] = Field(default_factory=list)
    evidence_count: int = 0
    first_seen: Optional[datetime] = None
    last_seen: Optional[datetime] = None
    cadence: SuggestionCadence = Field(default_factory=SuggestionCadence)
    workflow_title: str = ""
    workflow_steps: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.now)
    # Filled on accept so the FE can jump straight to the created workflow.
    workflow_id: Optional[str] = None
