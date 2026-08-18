import asyncio

import pytest
from pydantic import BaseModel, ConfigDict, ValidationError

from backend.apps.outputs.execution.ExecutionContract import (
    ExecutionRequest,
    ExecutionResult,
    ExecutorPort,
)
from backend.apps.outputs.execution.SubprocessExecutor import SubprocessExecutor


class FakeExecutor(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    provider_name: str = "fake"

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        return ExecutionResult(
            execution_id=request.execution_id,
            status="success",
            result={"seen": request.input_data},
            provider=self.provider_name,
            runtime_identity="fake-runtime",
            isolation_enforced=True,
        )


def test_fake_provider_preserves_execution_identity():
    request = ExecutionRequest(code="result = {}", input_data={"value": 3})
    executor = FakeExecutor()
    assert isinstance(executor, ExecutorPort)
    result = asyncio.run(executor.execute(request))
    assert result.execution_id == request.execution_id
    assert result.result == {"seen": {"value": 3}}


def test_request_rejects_unknown_policy_content():
    with pytest.raises(ValidationError):
        ExecutionRequest(code="result = {}", cloud_secret="never")


def test_desktop_adapter_preserves_success_shape():
    request = ExecutionRequest(code="result = {'sum': sum(input_data['nums'])}", input_data={"nums": [1, 2]})
    result = asyncio.run(SubprocessExecutor().execute(request))
    assert result.status == "success"
    assert result.result == {"sum": 3}
    assert result.provider == "desktop-legacy-subprocess"
    assert result.isolation_enforced is False


def test_desktop_adapter_maps_validation_rejection():
    request = ExecutionRequest(code="import os\nresult = {}")
    result = asyncio.run(SubprocessExecutor().execute(request))
    assert result.status == "rejected"
    assert result.result == {}
