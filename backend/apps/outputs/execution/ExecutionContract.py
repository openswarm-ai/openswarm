from __future__ import annotations

from typing import Any, Dict, Literal, Optional, Protocol, runtime_checkable
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field
from typeguard import typechecked


ExecutionStatus = Literal[
    "success",
    "rejected",
    "timed_out",
    "cancelled",
    "resource_exhausted",
    "internal_failure",
]


class ExecutionLimits(BaseModel):
    model_config = ConfigDict(validate_assignment=True, extra="forbid")

    wall_time_ms: int = Field(default=30_000, ge=1, le=300_000)
    cpu_time_ms: int = Field(default=30_000, ge=1, le=300_000)
    memory_bytes: int = Field(default=268_435_456, ge=16_777_216, le=2_147_483_648)
    process_count: int = Field(default=16, ge=1, le=256)
    disk_bytes: int = Field(default=67_108_864, ge=0, le=2_147_483_648)
    output_bytes: int = Field(default=1_048_576, ge=1, le=16_777_216)


class ExecutionRequest(BaseModel):
    model_config = ConfigDict(validate_assignment=True, extra="forbid")

    execution_id: str = Field(default_factory=lambda: uuid4().hex, min_length=32, max_length=32)
    policy_version: str = Field(default="f2a-v1", min_length=1, max_length=64)
    code: str = Field(min_length=1, max_length=1_000_000)
    input_data: Dict[str, Any] = Field(default_factory=dict)
    validation_mode: Literal["strict", "user_approved"] = "strict"
    egress_policy: Literal["deny", "provider_defined"] = "deny"
    limits: ExecutionLimits = Field(default_factory=ExecutionLimits)


class ExecutionResult(BaseModel):
    model_config = ConfigDict(validate_assignment=True, extra="forbid")

    execution_id: str
    status: ExecutionStatus
    result: Dict[str, Any] = Field(default_factory=dict)
    stdout: str = Field(default="", max_length=1_048_576)
    stderr: str = Field(default="", max_length=1_048_576)
    duration_ms: int = Field(default=0, ge=0)
    provider: str = Field(min_length=1, max_length=128)
    runtime_identity: str = Field(min_length=1, max_length=256)
    isolation_enforced: bool
    resource_limit_reason: Optional[str] = Field(default=None, max_length=128)
    error: Optional[str] = Field(default=None, max_length=1_000)


@runtime_checkable
class ExecutorPort(Protocol):
    @typechecked
    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        ...
