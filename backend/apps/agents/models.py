from pydantic import BaseModel, Field
from typing import Optional, Literal, Any
from datetime import datetime
from uuid import uuid4

class AgentConfig(BaseModel):
    name: str = Field(default_factory=lambda: f"Agent-{uuid4().hex[:6]}")
    model: str = "sonnet"
    mode: str = "agent"
    provider: str = "anthropic"
    system_prompt: Optional[str] = None
    allowed_tools: list[str] = Field(default_factory=lambda: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion"])
    max_turns: Optional[int] = None
    target_directory: Optional[str] = None  # if None, uses repo root
    dashboard_id: Optional[str] = None

class ApprovalRequest(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    session_id: str
    tool_name: str
    tool_input: dict[str, Any]
    created_at: datetime = Field(default_factory=datetime.now)

class ApprovalResponse(BaseModel):
    request_id: str
    behavior: Literal["allow", "deny"]
    message: Optional[str] = None
    updated_input: Optional[dict[str, Any]] = None

class Message(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    role: Literal["user", "assistant", "tool_call", "tool_result", "system"]
    content: Any  # str or list of content blocks
    timestamp: datetime = Field(default_factory=datetime.now)
    branch_id: str = "main"
    parent_id: Optional[str] = None
    context_paths: Optional[list[dict]] = None
    attached_skills: Optional[list[dict]] = None
    forced_tools: Optional[list[str]] = None
    images: Optional[list[dict]] = None
    hidden: bool = False

class MessageBranch(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    parent_branch_id: Optional[str] = None
    fork_point_message_id: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.now)

class ToolGroupMeta(BaseModel):
    id: str
    name: str
    svg: str = ""
    is_refined: bool = False

class AgentSession(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    name: str
    status: Literal["running", "waiting_approval", "completed", "error", "stopped"] = "running"
    provider: str = "anthropic"
    model: str = "sonnet"
    mode: str = "agent"
    sdk_session_id: Optional[str] = None
    system_prompt: Optional[str] = None
    allowed_tools: list[str] = Field(default_factory=list)
    max_turns: Optional[int] = None
    cwd: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.now)
    closed_at: Optional[datetime] = None
    cost_usd: float = 0.0
    tokens: dict[str, int] = Field(default_factory=lambda: {"input": 0, "output": 0})
    messages: list[Message] = Field(default_factory=list)
    pending_approvals: list[ApprovalRequest] = Field(default_factory=list)
    branches: dict[str, "MessageBranch"] = Field(default_factory=lambda: {"main": MessageBranch(id="main")})
    active_branch_id: str = "main"
    tool_group_meta: dict[str, "ToolGroupMeta"] = Field(default_factory=dict)
    dashboard_id: Optional[str] = None
    browser_id: Optional[str] = None
    parent_session_id: Optional[str] = None
    needs_fork: bool = False
