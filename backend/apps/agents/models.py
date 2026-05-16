from dataclasses import dataclass, field
from typing import Optional, Literal, Any, Dict, List
from datetime import datetime
from uuid import uuid4
import json

from backend.builtin_models import BaseModel, Field

@dataclass
class AgentConfig(BaseModel):
    name: str = Field(default_factory=lambda: f"Agent-{uuid4().hex[:6]}")
    model: str = "sonnet"
    mode: str = "agent"
    provider: str = "anthropic"
    system_prompt: Optional[str] = None
    allowed_tools: list[str] = Field(default_factory=lambda: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "AskUserQuestion"])
    max_turns: Optional[int] = None
    target_directory: Optional[str] = None
    dashboard_id: Optional[str] = None

@dataclass
class ApprovalRequest(BaseModel):
    session_id: str
    tool_name: str
    tool_input: dict[str, Any]
    id: str = Field(default_factory=lambda: uuid4().hex)
    created_at: datetime = Field(default_factory=datetime.now)

@dataclass
class Message(BaseModel):
    role: Literal["user", "assistant", "tool_call", "tool_result", "system", "thinking"]
    content: Any
    id: str = Field(default_factory=lambda: uuid4().hex)
    timestamp: datetime = Field(default_factory=datetime.now)
    branch_id: str = "main"
    parent_id: Optional[str] = None
    context_paths: Optional[list[dict]] = None
    attached_skills: Optional[list[dict]] = None
    forced_tools: Optional[list[str]] = None
    images: Optional[list[dict]] = None
    hidden: bool = False
    client_message_id: Optional[str] = None
    elapsed_ms: Optional[int] = None
    tokens: Optional[int] = None
    tool_count: Optional[int] = None
    input_tokens: Optional[int] = None

@dataclass
class MessageBranch(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    parent_branch_id: Optional[str] = None
    fork_point_message_id: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.now)

@dataclass
class ToolGroupMeta(BaseModel):
    id: str
    name: str
    svg: str = ""
    is_refined: bool = False

@dataclass
class AgentSession(BaseModel):
    name: str
    id: str = Field(default_factory=lambda: uuid4().hex)
    status: Literal["running", "waiting_approval", "completed", "error", "stopped"] = "running"
    provider: str = "anthropic"
    model: str = "sonnet"
    mode: str = "agent"
    sdk_session_id: Optional[str] = None
    system_prompt: Optional[str] = None
    allowed_tools: list[str] = Field(default_factory=list)
    max_turns: Optional[int] = None
    cwd: Optional[str] = None
    repo_url: Optional[str] = None
    branch: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.now)
    closed_at: Optional[datetime] = None
    first_response_at: Optional[datetime] = None
    approval_decisions: list[dict] = Field(default_factory=list)
    cost_usd: float = 0.0
    tokens: dict[str, int] = Field(default_factory=lambda: {"input": 0, "output": 0})
    agent_active_ms: int = 0
    time_per_model: dict[str, int] = Field(default_factory=dict)
    tool_latencies: dict[str, dict] = Field(default_factory=dict)
    browser_domains: list[str] = Field(default_factory=list)
    messages: list[Message] = Field(default_factory=list)
    pending_approvals: list[ApprovalRequest] = Field(default_factory=list)
    branches: dict[str, MessageBranch] = Field(default_factory=lambda: {"main": MessageBranch(id="main")})
    active_branch_id: str = "main"
    tool_group_meta: dict[str, ToolGroupMeta] = Field(default_factory=dict)
    dashboard_id: Optional[str] = None
    browser_id: Optional[str] = None
    parent_session_id: Optional[str] = None
    needs_fork: bool = False
    needs_fresh_session: bool = False
    pending_continuation: bool = False
    pending_continuation_prompt: Optional[str] = None
    active_mcps: list[str] = Field(default_factory=list)
    active_outputs: list[str] = Field(default_factory=list)
    framework_overhead_tokens: int = 0
    compact_threshold_pct: float = 0.65
    compacted_through_msg_id: Optional[str] = None
    context_soft_cap_pct: float = 0.90
    context_window: int = 200_000
    thinking_level: Literal["off", "low", "medium", "high", "auto"] = "auto"

    def __post_init__(self):
        # Handle recursive restoration of nested models if they were passed as dicts
        if isinstance(self.messages, list):
            self.messages = [m if isinstance(m, Message) else Message(**m) for m in self.messages]
        if isinstance(self.branches, dict):
            self.branches = {k: b if isinstance(b, MessageBranch) else MessageBranch(**b) for k, b in self.branches.items()}
        if isinstance(self.tool_group_meta, dict):
            self.tool_group_meta = {k: m if isinstance(m, ToolGroupMeta) else ToolGroupMeta(**m) for k, m in self.tool_group_meta.items()}
        if isinstance(self.pending_approvals, list):
            self.pending_approvals = [a if isinstance(a, ApprovalRequest) else ApprovalRequest(**a) for a in self.pending_approvals]
