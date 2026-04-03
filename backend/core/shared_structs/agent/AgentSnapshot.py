from pydantic import BaseModel, Field
from typing import Optional, List
from backend.core.shared_structs.agent.MessageLog import MessageLog
from backend.core.shared_structs.agent.ApprovalRequest import ApprovalRequest

class AgentSnapshot(BaseModel):
    """Wire-format representation of an Agent — no runtime fields (task, lock, on_event)."""
    session_id: str
    model: str
    mode: str
    status: str
    branch_id: str = "main"
    parent_id: Optional[str] = None
    messages: MessageLog = Field(default_factory=MessageLog)
    pending_approvals: List[ApprovalRequest] = Field(default_factory=list)
    sub_agents: list = Field(default_factory=list)
    sub_branches: list = Field(default_factory=list)