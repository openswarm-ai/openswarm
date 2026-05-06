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
    # Optional client-generated id used by the frontend to reconcile an
    # optimistic message bubble (rendered synchronously on send) with the
    # server-confirmed echo. Plumbed through send_message and round-tripped
    # back via the agent:message WS event so the frontend can dedupe.
    client_message_id: Optional[str] = None
    # Wall-clock duration in milliseconds spent producing this message's
    # content. For thinking blocks: time from content_block_start →
    # content_block_stop. Lets the persisted ThinkingBubble show
    # "Thought for Ns" on reload instead of falling back to the static
    # "Thoughts" label. Optional for back-compat with messages saved
    # before this field existed.
    elapsed_ms: Optional[int] = None
    # Approximate output tokens for this message's content. For thinking
    # blocks we use the same char/3.6 heuristic the live UI uses so the
    # number frozen on the persisted bubble matches what the user saw
    # rising during the stream. Pure display, not billing.
    tokens: Optional[int] = None
    # tool_count drives the "3 tools used" segment on the thinking pill.
    tool_count: Optional[int] = None
    # combined input + output + children tokens for the turn (overloaded name).
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
    # Origin remote and branch resolved at session start. Persisted so a
    # resumed session reattaches to the same project even if the user has
    # since `cd`'d elsewhere; also surfaced in the session list UI so the
    # user can tell two sessions apart by repo.
    repo_url: Optional[str] = None
    branch: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.now)
    closed_at: Optional[datetime] = None
    # Wall-clock of the first stream event from the agent SDK. Set once
    # at the start of the first turn so resumed sessions can show "first
    # response was at HH:MM" in the session list without rescanning the
    # message log.
    first_response_at: Optional[datetime] = None
    # Operational log of HITL approval decisions, one entry per request:
    # {tool, behavior, decision_ms}. Persisted alongside the session so a
    # reload restores the full approval timeline (which calls were
    # approved, denied, and how long each took).
    approval_decisions: list[dict] = Field(default_factory=list)
    cost_usd: float = 0.0
    tokens: dict[str, int] = Field(default_factory=lambda: {"input": 0, "output": 0})
    # Total wall-clock ms the agent spent in `status="running"`. Accumulates
    # across turns; persists across resume. Used by the session-close
    # report so we can report "agent active time" alongside total session
    # duration. Off by default so legacy sessions deserialize cleanly.
    agent_active_ms: int = 0
    # Accumulated wall-clock ms spent on each model. Updated when the
    # active model changes (model switch) or on close. Surfaced in the
    # session header so the user can see "Sonnet: 45s · Haiku: 12s"
    # without scanning turns by hand.
    time_per_model: dict[str, int] = Field(default_factory=dict)
    # Per-tool latency rollup: { tool_name: { count, total_ms, max_ms } }.
    # Populated as tools complete. Surfaced in the session "tools used"
    # row so the user can see which tool calls were slow without
    # opening every turn.
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
    # Stronger than needs_fork: when True, the next turn drops `resume=`
    # entirely and replays history into a brand-new sdk_session_id. This
    # is the only way to make the bundled CLI re-read mcp_servers from
    # the rebuilt options dict — `fork_session=True` only forks the
    # conversation tree, it inherits the original transport's MCP server
    # set. Set after MCPActivate when prior turns exist so the newly
    # activated server's tools actually reach the model.
    needs_fresh_session: bool = False
    # Set when MCPActivate (or analogous activation) wants the agent to
    # auto-continue immediately after the current turn ends — without
    # requiring the user to type another message. The agent loop reads
    # this at the end of `_run_agent_loop`; if set, it clears it and
    # dispatches a new hidden turn with `pending_continuation_prompt` as
    # the prompt. Race-free vs. the original asyncio-task approach.
    pending_continuation: bool = False
    pending_continuation_prompt: Optional[str] = None
    # Sanitized server names (matching tools_lib._sanitize_server_name) of MCP
    # servers the model has explicitly activated this session via the
    # MCPActivate meta-tool. Empty by default — the gate in
    # _build_mcp_servers intersects connected MCPs with this list, so no
    # MCP tool is callable until the model searches for and activates a
    # server. The product invariant is that this is non-bypassable: the
    # filter lives at the dispatch layer (mcp_servers passed to the SDK),
    # not the prompt layer.
    active_mcps: list[str] = Field(default_factory=list)
    # Output ids the model has activated this session via the
    # OutputActivate meta-tool. Empty by default — _build_outputs_context
    # only emits the cheap one-line index for unactivated outputs; full
    # input_schema is shipped only for the ids in this list. Same gate
    # pattern as active_mcps but for the Outputs/Views surface.
    active_outputs: list[str] = Field(default_factory=list)
    # Compaction state. compact_threshold_pct is the live ctx_used ratio
    # that triggers _maybe_compact at the next turn boundary — turn-based
    # thresholds break under uneven workloads (one big Bash dump fills
    # context fast; 30 chitchat turns barely move it). 0.65 = 130K of the
    # 200K standard tier. compacted_through_msg_id is the last message id
    # covered by the most recent summary so we don't re-summarize on
    # every turn.
    compact_threshold_pct: float = 0.65
    compacted_through_msg_id: Optional[str] = None
    # Pre-send hard guard. Fires later than the compaction threshold —
    # 0.90 of 200K = 180K — to give the auto-compact path a chance to
    # bring the request back under the ceiling. If still over after
    # compaction, LRU-trim the oldest active_outputs / active_mcps. Past
    # this we surface the friendly context-overflow card instead of
    # letting a 429 hit.
    context_soft_cap_pct: float = 0.90
    context_window: int = 200_000
    # How much the model should "think" before answering. Provider-agnostic
    # value that gets translated per-API in agent_manager:
    #   off    — no thinking
    #   low    — minimal thinking (fastest)
    #   medium — balanced
    #   high   — extensive thinking (slowest, smartest)
    #   auto   — let the model / provider default decide (recommended)
    # Only applies to models flagged with reasoning: True in the registry.
    # Existing sessions without this field will default to "auto".
    thinking_level: Literal["off", "low", "medium", "high", "auto"] = "auto"
