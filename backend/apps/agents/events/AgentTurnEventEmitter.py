from __future__ import annotations

import time
from threading import RLock
from typing import Any, Dict, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, InstanceOf
from typeguard import typechecked

from backend.apps.agents.events.AgentEvent import (
    ToolCompletedEvent,
    ToolStartedEvent,
    TurnCompletedEvent,
    TurnFailedEvent,
    TurnFirstTokenEvent,
    TurnStartedEvent,
)
from backend.apps.agents.events.AgentEventSink import AgentEventSink, emit_agent_event


class AgentTurnEventEmitter(BaseModel):
    model_config = ConfigDict(validate_assignment=True, arbitrary_types_allowed=True)

    sink: InstanceOf[AgentEventSink]
    session_id: str
    provider: str
    model: str
    turn_id: str = Field(default_factory=lambda: uuid4().hex)
    sequence: int = 0
    started_monotonic: float = Field(default_factory=time.monotonic)
    first_token_emitted: bool = False
    tool_starts: Dict[str, float] = Field(default_factory=dict)
    tool_names: Dict[str, str] = Field(default_factory=dict)
    p_lock: Any = Field(default_factory=RLock, exclude=True)

    @typechecked
    def emit_started(self) -> None:
        with self.p_lock:
            emit_agent_event(self.sink, TurnStartedEvent(**self.next_fields(), provider=self.provider, model=self.model))

    @typechecked
    def emit_first_token(self) -> None:
        with self.p_lock:
            if self.first_token_emitted:
                return
            self.first_token_emitted = True
            emit_agent_event(
                self.sink,
                TurnFirstTokenEvent(**self.next_fields(), ttft_ms=self.duration_ms()),
            )

    @typechecked
    def emit_tool_started(self, tool_call_id: str, tool_name: str) -> None:
        with self.p_lock:
            safe_id = tool_call_id[:128]
            if not safe_id or safe_id in self.tool_starts:
                return
            safe_name = (tool_name or "unknown")[:128]
            self.tool_starts[safe_id] = time.monotonic()
            self.tool_names[safe_id] = safe_name
            emit_agent_event(
                self.sink,
                ToolStartedEvent(
                    **self.next_fields(),
                    tool_call_id=safe_id,
                    tool_name=safe_name,
                ),
            )

    @typechecked
    def emit_tool_completed(
        self,
        tool_call_id: str,
        tool_name: str,
        status: Literal["success", "error", "cancelled"] = "success",
        error_type: str | None = None,
    ) -> None:
        with self.p_lock:
            safe_id = tool_call_id[:128]
            if not safe_id:
                return
            if safe_id not in self.tool_starts:
                self.emit_tool_started(safe_id, tool_name)
            started = self.tool_starts.pop(safe_id, time.monotonic())
            safe_name = self.tool_names.pop(safe_id, (tool_name or "unknown")[:128])
            emit_agent_event(
                self.sink,
                ToolCompletedEvent(
                    **self.next_fields(),
                    tool_call_id=safe_id,
                    tool_name=safe_name,
                    duration_ms=max(0, int((time.monotonic() - started) * 1000)),
                    status=status,
                    error_type=error_type[:128] if error_type else None,
                ),
            )

    @typechecked
    def close_open_tools(self, status: Literal["error", "cancelled"] = "cancelled") -> None:
        with self.p_lock:
            for tool_call_id in list(self.tool_starts):
                self.emit_tool_completed(
                    tool_call_id,
                    self.tool_names.get(tool_call_id, "unknown"),
                    status=status,
                    error_type="turn_ended" if status == "error" else None,
                )

    @typechecked
    def emit_completed(self, input_tokens: int = 0, output_tokens: int = 0) -> None:
        with self.p_lock:
            self.close_open_tools()
            emit_agent_event(
                self.sink,
                TurnCompletedEvent(
                    **self.next_fields(),
                    duration_ms=self.duration_ms(),
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                ),
            )

    @typechecked
    def emit_failed(self, error_type: str, retryable: bool = False) -> None:
        with self.p_lock:
            self.close_open_tools(status="error")
            emit_agent_event(
                self.sink,
                TurnFailedEvent(
                    **self.next_fields(),
                    duration_ms=self.duration_ms(),
                    error_type=error_type[:128],
                    retryable=retryable,
                ),
            )

    @typechecked
    def next_fields(self) -> Dict[str, Any]:
        fields: Dict[str, Any] = {
            "session_id": self.session_id,
            "turn_id": self.turn_id,
            "sequence": self.sequence,
            "monotonic_ms": int(time.monotonic() * 1000),
        }
        self.sequence += 1
        return fields

    @typechecked
    def duration_ms(self) -> int:
        return max(0, int((time.monotonic() - self.started_monotonic) * 1000))
