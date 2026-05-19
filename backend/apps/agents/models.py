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
    target_directory: Optional[str] = None
    dashboard_id: Optional[str] = None

class ApprovalRequest(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    session_id: str
    tool_name: str
    tool_input: dict[str, Any]
    created_at: datetime = Field(default_factory=datetime.now)
    # Set when this approval was triggered by the sensitive-path override
    # rather than the user's normal "ask" policy. Three correlated fields:
    #   - sensitive_pattern: the fnmatch pattern (canonical id; what we
    #     persist into the trusted allowlist if the user opts in).
    #   - sensitive_label: short human label (e.g. "SSH folder (~/.ssh)").
    #   - sensitive_why: plain-English risk explanation; lets the modal
    #     justify itself to a non-developer.
    # All three None for ordinary "ask" approvals.
    sensitive_pattern: Optional[str] = None
    sensitive_label: Optional[str] = None
    sensitive_why: Optional[str] = None

class ApprovalResponse(BaseModel):
    request_id: str
    behavior: Literal["allow", "deny"]
    message: Optional[str] = None
    updated_input: Optional[dict[str, Any]] = None
    # When the user checked "Always allow files like this" on a sensitive-
    # path approval, the backend persists the matched fnmatch pattern
    # (from ApprovalRequest.sensitive_pattern) to disk so future writes
    # against the same pattern skip the modal.
    trust_pattern: bool = False

class Message(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    role: Literal["user", "assistant", "tool_call", "tool_result", "system", "thinking"]
    content: Any  # str or list of content blocks
    timestamp: datetime = Field(default_factory=datetime.now)
    branch_id: str = "main"
    parent_id: Optional[str] = None
    context_paths: Optional[list[dict]] = None
    attached_skills: Optional[list[dict]] = None
    forced_tools: Optional[list[str]] = None
    images: Optional[list[dict]] = None
    hidden: bool = False
    # Frontend-generated id for optimistic-bubble dedup against the server echo.
    client_message_id: Optional[str] = None
    # Wall-clock ms producing this message's content; for thinking, content_block_start -> stop. Lets reloaded bubbles show "Thought for Ns".
    elapsed_ms: Optional[int] = None
    # Approx output tokens; thinking uses char/3.6 to match the live UI's count. Display only.
    tokens: Optional[int] = None
    # Drives the "N tools used" segment on the thinking pill.
    tool_count: Optional[int] = None
    # Combined input + output + children tokens for the turn (overloaded name).
    input_tokens: Optional[int] = None

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
    # Resolved at session start so resume reattaches to the same repo even after the user cd's elsewhere.
    repo_url: Optional[str] = None
    branch: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.now)
    closed_at: Optional[datetime] = None
    # Wall-clock of the first stream event so resumed sessions can show "first response at HH:MM" without rescan.
    first_response_at: Optional[datetime] = None
    # HITL approval log: {tool, behavior, decision_ms} per entry.
    approval_decisions: list[dict] = Field(default_factory=list)
    cost_usd: float = 0.0
    tokens: dict[str, int] = Field(default_factory=lambda: {"input": 0, "output": 0})
    # Total ms in status="running", accumulated across turns/resume; powers session-close "agent active time".
    agent_active_ms: int = 0
    # Per-model wall-clock ms; updated on model switch or close.
    time_per_model: dict[str, int] = Field(default_factory=dict)
    # Per-tool latency: { tool_name: { count, total_ms, max_ms } }.
    tool_latencies: dict[str, dict] = Field(default_factory=dict)
    browser_domains: list[str] = Field(default_factory=list)
    messages: list[Message] = Field(default_factory=list)
    pending_approvals: list[ApprovalRequest] = Field(default_factory=list)
    branches: dict[str, "MessageBranch"] = Field(default_factory=lambda: {"main": MessageBranch(id="main")})
    active_branch_id: str = "main"
    tool_group_meta: dict[str, "ToolGroupMeta"] = Field(default_factory=dict)
    dashboard_id: Optional[str] = None
    browser_id: Optional[str] = None
    parent_session_id: Optional[str] = None
    needs_fork: bool = False
    # Stronger than needs_fork: drop resume= and replay history into a fresh sdk_session_id; fork_session alone won't re-read mcp_servers.
    needs_fresh_session: bool = False
    # Auto-continue: agent loop dispatches a hidden turn at end-of-loop using pending_continuation_prompt. Race-free vs background tasks.
    pending_continuation: bool = False
    pending_continuation_prompt: Optional[str] = None
    # Sanitized server names model has explicitly activated this session; _build_mcp_servers intersects connected MCPs with this. Non-bypassable; dispatch-layer gate.
    active_mcps: list[str] = Field(default_factory=list)
    # Heuristic preamble tokens (preset + tool defs + MCP descs + composed prompt); subtracted from displayed input.
    framework_overhead_tokens: int = 0
    # Live ctx_used ratio triggering _maybe_compact at the next turn boundary; turn-based thresholds break under uneven workloads. 0.65 = 130K of 200K.
    compact_threshold_pct: float = 0.65
    compacted_through_msg_id: Optional[str] = None
    # Hard pre-send guard at 0.90 (= 180K); past compaction we LRU-trim active_mcps, then surface the overflow card.
    context_soft_cap_pct: float = 0.90
    context_window: int = 200_000
    # Provider-agnostic thinking level (off/low/medium/high/auto), translated per-API in agent_manager; only affects reasoning-flagged models.
    thinking_level: Literal["off", "low", "medium", "high", "auto"] = "auto"
