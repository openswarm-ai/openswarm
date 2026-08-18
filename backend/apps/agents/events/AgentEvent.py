from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Literal, Optional, Union
from uuid import uuid4

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, TypeAdapter
from typeguard import typechecked


@typechecked
def p_event_id() -> str:
    return uuid4().hex


@typechecked
def p_now() -> datetime:
    return datetime.now(timezone.utc)


class AgentEventBase(BaseModel):
    model_config = ConfigDict(validate_assignment=True, extra="forbid", frozen=True)
    schema_version: Literal["1"] = "1"
    event_id: str = Field(default_factory=p_event_id, min_length=32, max_length=32, pattern=r"^[0-9a-f]{32}$")
    session_id: str = Field(min_length=1, max_length=128)
    turn_id: str = Field(min_length=1, max_length=128)
    sequence: int = Field(ge=0)
    occurred_at: AwareDatetime = Field(default_factory=p_now)
    monotonic_ms: int = Field(ge=0)


class TurnStartedEvent(AgentEventBase):
    kind: Literal["turn.started"] = "turn.started"
    provider: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=128)


class TurnFirstTokenEvent(AgentEventBase):
    kind: Literal["turn.first_token"] = "turn.first_token"
    ttft_ms: int = Field(ge=0)


class ToolStartedEvent(AgentEventBase):
    kind: Literal["tool.started"] = "tool.started"
    tool_call_id: str = Field(min_length=1, max_length=128)
    tool_name: str = Field(min_length=1, max_length=128)


class ToolCompletedEvent(AgentEventBase):
    kind: Literal["tool.completed"] = "tool.completed"
    tool_call_id: str = Field(min_length=1, max_length=128)
    tool_name: str = Field(min_length=1, max_length=128)
    duration_ms: int = Field(ge=0)
    status: Literal["success", "error", "cancelled"]
    error_type: Optional[str] = Field(default=None, max_length=128)


class TurnCompletedEvent(AgentEventBase):
    kind: Literal["turn.completed"] = "turn.completed"
    duration_ms: int = Field(ge=0)
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)


class TurnFailedEvent(AgentEventBase):
    kind: Literal["turn.failed"] = "turn.failed"
    duration_ms: int = Field(ge=0)
    error_type: str = Field(min_length=1, max_length=128)
    retryable: bool = False


AgentEvent = Annotated[
    Union[
        TurnStartedEvent,
        TurnFirstTokenEvent,
        ToolStartedEvent,
        ToolCompletedEvent,
        TurnCompletedEvent,
        TurnFailedEvent,
    ],
    Field(discriminator="kind"),
]

P_AGENT_EVENT_ADAPTER = TypeAdapter(AgentEvent)


@typechecked
def parse_agent_event(value: object) -> AgentEvent:
    return P_AGENT_EVENT_ADAPTER.validate_python(value)
