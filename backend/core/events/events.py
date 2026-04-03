from pydantic import BaseModel, Field
from typing import Annotated, List, Literal, Optional, Union, Callable, Awaitable

from backend.core.Agent.shared_structs.Message.Message import AnyMessage
from backend.core.Agent.shared_structs.MessageLog import MessageLog
from backend.core.Agent.shared_structs.ApprovalRequest import ApprovalRequest
from backend.OLDapps.dashboards.models import BrowserCardPosition


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


class AgentStatusEvent(BaseModel):
    event: Literal["agent:status"] = "agent:status"
    session_id: str
    status: str
    session: Optional[AgentSnapshot] = None


class AgentMessageEvent(BaseModel):
    event: Literal["agent:message"] = "agent:message"
    session_id: str
    message: AnyMessage


class StreamStartEvent(BaseModel):
    event: Literal["agent:stream_start"] = "agent:stream_start"
    session_id: str
    message_id: str
    role: str
    tool_name: Optional[str] = None


class StreamDeltaEvent(BaseModel):
    event: Literal["agent:stream_delta"] = "agent:stream_delta"
    session_id: str
    message_id: str
    delta: str


class StreamEndEvent(BaseModel):
    event: Literal["agent:stream_end"] = "agent:stream_end"
    session_id: str
    message_id: str


class BranchSwitchedEvent(BaseModel):
    event: Literal["agent:branch_switched"] = "agent:branch_switched"
    session_id: str
    active_branch_id: str


class AgentClosedEvent(BaseModel):
    event: Literal["agent:closed"] = "agent:closed"
    session_id: str
    status: str
    closed_at: str


class BrowserCardAddedEvent(BaseModel):
    event: Literal["dashboard:browser_card_added"] = "dashboard:browser_card_added"
    dashboard_id: str
    browser_card: BrowserCardPosition


AnyEvent = Annotated[
    Union[
        AgentStatusEvent, AgentMessageEvent,
        StreamStartEvent, StreamDeltaEvent, StreamEndEvent,
        BranchSwitchedEvent, AgentClosedEvent, BrowserCardAddedEvent,
    ],
    Field(discriminator="event"),
]

EventCallback = Callable[[AnyEvent], Awaitable[None]]