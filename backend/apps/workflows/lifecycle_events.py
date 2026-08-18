from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Protocol

WorkflowPayload = dict[str, Any]
BroadcastCallback = Callable[[str, WorkflowPayload], Awaitable[None]]


class WorkflowLifecycleEventPort(Protocol):
    async def workflow_updated(
        self, workflow_id: str, workflow: WorkflowPayload
    ) -> None: ...

    async def workflow_deleted(self, workflow_id: str) -> None: ...


class BroadcastWorkflowLifecycleEvents:
    def __init__(self, broadcast: BroadcastCallback) -> None:
        self.p_broadcast = broadcast

    async def workflow_updated(
        self, workflow_id: str, workflow: WorkflowPayload
    ) -> None:
        try:
            await self.p_broadcast(
                "workflow:updated",
                {"workflow_id": workflow_id, "workflow": workflow},
            )
        except Exception:
            pass

    async def workflow_deleted(self, workflow_id: str) -> None:
        try:
            await self.p_broadcast("workflow:deleted", {"workflow_id": workflow_id})
        except Exception:
            pass


def workflow_lifecycle_event_publisher() -> WorkflowLifecycleEventPort:
    from backend.apps.agents.core.ws_manager import ws_manager

    return BroadcastWorkflowLifecycleEvents(ws_manager.broadcast_global)
