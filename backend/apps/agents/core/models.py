from pydantic import BaseModel, Field
from typing import Optional, Literal, Any
from datetime import datetime
from uuid import uuid4

class AgentConfig(BaseModel):
    name: str = ""
    # First-turn prompt. Launch used to silently DROP this (pydantic ignores unknown fields), leaving the session claiming "running" forever with zero messages and no error, the ENG-131 ghost hang.
    prompt: Optional[str] = None
    model: str = "sonnet"
    mode: str = "agent"
    provider: str = "anthropic"
    system_prompt: Optional[str] = None
    # None means "whatever the mode allows". A list is an actual restriction and IS enforced at launch, so it must stay None unless the caller really means to narrow the surface.
    allowed_tools: Optional[list[str]] = None
    max_turns: Optional[int] = None
    target_directory: Optional[str] = None
    dashboard_id: Optional[str] = None
    workflow_run_id: Optional[str] = None
    workflow_edit_id: Optional[str] = None
    # App cards the user picked to edit. When exactly one resolves, launch binds the chat's cwd to that app instead of seeding a new "Untitled App".
    selected_app_output_ids: Optional[list[str]] = None
    # Onboarding auto-launches an audit over the user's REAL files with nobody watching, so it runs
    # read-only: Read/Grep/Glob + Write (its one report) allowed, Edit/Bash/NotebookEdit hard-blocked
    # so "modify or delete an existing file" is unrepresentable, not just discouraged by the prompt.
    read_only: bool = False

class ApprovalRequest(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    session_id: str
    tool_name: str
    tool_input: dict[str, Any]
    created_at: datetime = Field(default_factory=datetime.now)
    # Set when this approval was triggered by the sensitive-path override rather than the user's normal "ask" policy. Three correlated fields: - sensitive_pattern: the fnmatch pattern (canonical id; what we persist into the trusted allowlist if the user opts in). - sensitive_label: short human label (e.g. "SSH folder (~/.ssh)"). - sensitive_why: plain-English risk explanation; lets the modal justify itself to a non-developer. All three None for ordinary "ask" approvals.
    sensitive_pattern: Optional[str] = None
    sensitive_label: Optional[str] = None
    sensitive_why: Optional[str] = None

class ApprovalResponse(BaseModel):
    request_id: str
    behavior: Literal["allow", "deny"]
    message: Optional[str] = None
    updated_input: Optional[dict[str, Any]] = None
    # When the user checked "Always allow files like this" on a sensitive- path approval, the backend persists the matched fnmatch pattern (from ApprovalRequest.sensitive_pattern) to disk so future writes against the same pattern skip the modal.
    trust_pattern: bool = False
    # "Always approve" button: persist this tool's policy to always_allow so the same tool stops prompting (the catastrophic/sensitive guards still fire, so this can't blanket-approve an rm -rf or a sensitive-path write).
    set_always_allow: bool = False

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
    # Hard-block the mutation/exec tools for this session (onboarding's unattended audit); see AgentConfig.read_only.
    read_only: bool = False
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
    # Set when this session IS a workflow run's agent; the run renders in the Workflows monitor card, so the canvas suppresses the duplicate standalone agent card.
    workflow_run_id: Optional[str] = None
    # Set when this session IS a workflow's embedded edit/compose chat; it lives in the Workflows hub window, so the canvas suppresses its standalone card and docks its browser below the hub.
    workflow_edit_id: Optional[str] = None
    workflow_test_state: Optional[Literal["running", "complete", "error"]] = None
    # Browser memory signals, drive the subtle "remembered/learned" card chip so the user feels the agent getting smarter without lifting a finger.
    memory_recalled: bool = False
    memory_learned: bool = False
    needs_fork: bool = False
    # Stronger than needs_fork: drop resume= and replay history into a fresh sdk_session_id; fork_session alone won't re-read mcp_servers.
    needs_fresh_session: bool = False
    # A new CLI process that RESUMES the same transcript (dead transport, stale token, core sidecar never connected); unlike needs_fresh_session nothing is rebuilt, so no history is ever re-authored as text (ENG-382).
    needs_respawn: bool = False
    # Auto-continue: agent loop dispatches a hidden turn at end-of-loop using pending_continuation_prompt. Race-free vs background tasks.
    pending_continuation: bool = False
    pending_continuation_prompt: Optional[str] = None
    # The final silent-quit nudge runs with ZERO tools, so "do not call any more tools" stops being a request the model can decline (ENG-291).
    pending_continuation_toolless: bool = False
    # Silent-quit nudges spent since the user's last real message; hard-capped so an agent that keeps ending empty can't loop.
    empty_finish_nudges: int = 0
    # Lifetime silent-quit count for the session; unlike the per-user-message nudge counter this never resets, so a REPEAT quit is distinguishable from a first (Haik's storm sessions logged 130+ quits each).
    empty_finish_total: int = 0
    # One transparent expired-token retry per user ask; the second failure earns the honest banner (ENG-294).
    auth_retry_used: bool = False
    # Tool-call count at the last nudge: a re-nudge is only earned by NEW tool work since then.
    empty_finish_progress_mark: int = 0
    # One honest "stopped without a report" line per exhausted nudge budget; resets with the budget.
    empty_finish_surfaced: bool = False
    # What a fresh CLI session may carry as history: "minimal" (the user's asks, the tool trail, a model-written summary of the dropped span; never the model's own replies verbatim) or "none". Ratchets to "none" when a provider policy filter blocks a recap-bearing turn and never back up: on the subscription lane Anthropic's anti-distillation classifier blocked 192 of our recap turns in 14 days (0 on API keys), reading replayed model text as "duplicating model outputs".
    history_prefix_mode: Literal["minimal", "summary", "none"] = "minimal"
    # A ONE-TURN narrowing, consumed at spawn. The nudge ladder's last rung uses "summary" so
    # its request is bounded BY CONSTRUCTION (a model-written gist, no trail, no replay) rather
    # than walking into the same context that already ate rungs 1 and 2. It can only ever
    # narrow: a policy ratchet at "none" is never widened back by an override (ENG-399).
    history_prefix_once: Optional[Literal["summary", "none"]] = None
    # What the LAST spawned turn actually carried, so a block can tell a recap-caused refusal from a plain one.
    history_prefix_sent: Literal["minimal", "summary", "none"] = "none"
    # Consecutive dirty deaths this session was MID-TURN for; the crash auto-resume breaker (hermes #30719 pairing: auto-resume must never outrun its circuit breaker).
    crash_interrupt_count: int = 0
    # Outage rounds spent on this ask: the in-turn ladder covers only 335s, and the work is checkpointed, so a longer drop is waited out rather than ending the task.
    # True when the preflight found the router had already given up on this lane, so an auth failure this turn is a dead credential, not a rotation window worth waiting out.
    # Input-token level history must regrow past before another proactive prune may commit; a rebuild busts the prompt cache, so one per runway, never one per turn.
    proactive_prune_rearm_tokens: int = 0
    lane_credential_dead: bool = False
    # Transient provider errors arrive as assistant TEXT, so no upstream retry sees them; budgeted apart from auth_retry_used so a rate limit cannot spend the expired-token retry.
    transient_retry_count: int = 0
    # Set once the provider gives a verdict waiting cannot change (a spent plan, a dead credential).
    # Further recovery retries after that only produce cards contradicting the one we already showed.
    provider_verdict_final: bool = False
    # A HUMAN ended this session (Stop, close, delete). Every automatic resume path (delegation watchdog retry, crash auto-resume, hidden continuation, a read reviving it from disk) stands down; only the human's own next message clears it.
    ended_by_user: bool = False
    # The last provider-error KIND surfaced this ask. Cards alternated (spent/rate-limit/spent) so
    # the identical-string dedup never engaged and the user got a wall of contradictions.
    last_provider_error_kind: str = ""
    reconnect_attempts: int = 0
    # True while a turn is parked waiting for the connection back; persisted so a quit DURING the wait is still an owed turn at next boot.
    awaiting_reconnect: bool = False
    # Seconds the auto-continuation dispatcher sleeps before sending (codex rotation windows last 1-2 min; an instant retry lands inside the same window and burns the one-shot budget).
    pending_continuation_delay_s: int = 0
    # Memory prompt block frozen at first compose (prefix-cache discipline: mid-chat fact writes must
    # not shift the prompt bytes). Excluded from persistence so a resumed session re-snapshots fresh.
    memory_snapshot: Optional[str] = Field(default=None, exclude=True)
    # Sanitized server names model has explicitly activated this session; _build_mcp_servers intersects connected MCPs with this. Non-bypassable; dispatch-layer gate.
    active_mcps: list[str] = Field(default_factory=list)
    # Heuristic preamble tokens (preset + tool defs + MCP descs + composed prompt); subtracted from displayed input.
    framework_overhead_tokens: int = 0
    # Live ctx_used ratio triggering _maybe_compact at the next turn boundary; turn-based thresholds break under uneven workloads. Ratio of context_window, so 0.65 means 650K on a 1M-window model and 130K on a 200K-window model.
    compact_threshold_pct: float = 0.65
    # Absolute token ceiling so big-window models don't sit at 650K before marking; the marker fires at the TIGHTER of the pct or this cap, so it's never "just 65%".
    compact_abs_ceiling_tokens: int = 180_000
    compacted_through_msg_id: Optional[str] = None
    # Aux-LLM distilled summary of the turns dropped by compaction, cached against the cutoff id it was built for; keeps the gist of old history on a rebuild instead of a hard drop.
    compacted_summary: Optional[str] = None
    compacted_summary_through: Optional[str] = None
    # Hard pre-send guard at 0.90; past compaction we LRU-trim active_mcps, then surface the overflow card.
    context_soft_cap_pct: float = 0.90
    # Conservative default. Always overwritten at session creation, restore, and model-switch via apply_context_window in agent_manager so the real model cap is used instead. Don't bump this without re-checking the trim/guard logic.
    context_window: int = 200_000
    # Provider-agnostic thinking level (off/low/medium/high/auto), translated per-API in agent_manager; only affects reasoning-flagged models.
    thinking_level: Literal["off", "low", "medium", "high", "auto"] = "auto"
