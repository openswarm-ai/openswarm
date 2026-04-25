from pydantic import BaseModel, Field, field_serializer
from typing import Any, Optional, List
from backend.core.shared_structs.agent.MessageLog import MessageLog
from backend.core.shared_structs.agent.ApprovalRequest import ApprovalRequest

class AgentSnapshot(BaseModel):
    """Wire-format representation of an Agent — no runtime fields (task, lock, on_event)."""
    session_id: str = Field(..., serialization_alias="id")
    model: str
    mode: str
    status: str
    name: str = "New chat"
    created_at: str = ""
    cost_usd: float = 0
    dashboard_id: Optional[str] = None
    branch_id: str = "main"
    parent_id: Optional[str] = None
    messages: MessageLog = Field(default_factory=MessageLog)
    pending_approvals: List[ApprovalRequest] = Field(default_factory=list)
    sub_agents: list = Field(default_factory=list)
    sub_branches: list = Field(default_factory=list)

    # Flatten MessageLog -> list[Message] on the wire so consumers (frontend,
    # WS clients) get a plain array instead of {"messages": [...]}. Using a
    # field_serializer ensures this works whether AgentSnapshot is dumped
    # directly or as a nested field of a parent model (e.g. AgentStatusEvent),
    # which a custom model_dump override does not handle.
    @field_serializer("messages")
    def _serialize_messages(self, messages: MessageLog, _info: Any) -> list[dict[str, Any]]:
        return [m.model_dump(mode="json") for m in messages.messages]

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:
        kwargs.setdefault("by_alias", True)
        return super().model_dump(**kwargs)
