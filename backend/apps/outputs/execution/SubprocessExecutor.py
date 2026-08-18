from __future__ import annotations

import sys
import time

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.outputs.execution.ExecutionContract import ExecutionRequest, ExecutionResult, ExecutionStatus
from backend.apps.outputs.code_safety import UnsafeCodeError
from backend.apps.outputs.executor import execute_backend_code


class SubprocessExecutor(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    provider_name: str = "desktop-legacy-subprocess"

    @typechecked
    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        started = time.monotonic()
        try:
            result = await execute_backend_code(
                request.code,
                request.input_data,
                approved=request.validation_mode == "user_approved",
            )
            return ExecutionResult(
                execution_id=request.execution_id,
                status="success",
                result=result.result,
                stdout=result.stdout,
                stderr=result.stderr,
                duration_ms=int((time.monotonic() - started) * 1000),
                provider=self.provider_name,
                runtime_identity=sys.version,
                isolation_enforced=False,
            )
        except UnsafeCodeError as exc:
            return self.failure(request, "rejected", started, str(exc))
        except Exception as exc:
            status: ExecutionStatus = "timed_out" if "timed out" in str(exc).lower() else "internal_failure"
            return self.failure(request, status, started, str(exc))

    @typechecked
    def failure(
        self,
        request: ExecutionRequest,
        status: ExecutionStatus,
        started: float,
        error: str,
    ) -> ExecutionResult:
        return ExecutionResult(
            execution_id=request.execution_id,
            status=status,
            duration_ms=int((time.monotonic() - started) * 1000),
            provider=self.provider_name,
            runtime_identity=sys.version,
            isolation_enforced=False,
            error=error[:1_000],
        )
