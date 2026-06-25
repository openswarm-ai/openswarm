"""Per-session workflow approval memory + the gate's resolve-ask helper.

The workflow executor pushes context in (keyed by session id) so the permission
gates can reuse a prior allow/deny instead of prompting, and so an unattended
fire fails fast instead of parking for ten minutes. Lives down here (not in the
workflows app) so both the gate hooks and the executor import it downward;
agent_manager re-exports the setters for the executor's convenience.
"""

import logging
from typing import Callable, Dict, Optional

from pydantic import BaseModel, ConfigDict
from typeguard import typechecked

from backend.apps.agents.manager.permissions.ApprovalDecision import ApprovalDecision
from backend.apps.agents.manager.permissions.decision import request_user_approval
from backend.apps.agents.manager.streaming.HookContext import HookContext

logger = logging.getLogger(__name__)


class WorkflowApprovalMemory(BaseModel):
    """A workflow run's approval context, pushed in by the executor."""

    model_config = ConfigDict(validate_assignment=True)

    decisions: Dict[str, str]                       # workflow-level: tool -> "allow"/"deny"
    step_usage: Dict[str, Dict[str, bool]]          # per-step record: step_id -> {tool: approved}
    remember: Optional[Callable[[str, str], None]]  # persist a workflow-level decision to disk
    ask_timeout: float
    # The executor bumps this as it advances steps so the gate can record which tools each step touched. None on test runs that don't thread it.
    current_step_id: Optional[str] = None


p_approval_memory: Dict[str, WorkflowApprovalMemory] = {}


@typechecked
def set_workflow_approval_memory(
    session_id: str,
    *,
    decisions: Dict[str, str],
    step_usage: Dict[str, Dict[str, bool]],
    remember: Optional[Callable[[str, str], None]],
    ask_timeout: float,
) -> None:
    p_approval_memory[session_id] = WorkflowApprovalMemory(
        decisions=decisions, step_usage=step_usage, remember=remember, ask_timeout=ask_timeout
    )


@typechecked
def clear_workflow_approval_memory(session_id: str) -> None:
    p_approval_memory.pop(session_id, None)


@typechecked
def set_workflow_approval_step(session_id: str, step_id: Optional[str]) -> None:
    mem = p_approval_memory.get(session_id)
    if mem is not None:
        mem.current_step_id = step_id


@typechecked
def get_workflow_step_usage(session_id: str) -> Dict[str, Dict[str, bool]]:
    mem = p_approval_memory.get(session_id)
    return mem.step_usage if mem is not None else {}


@typechecked
def is_claude_schedule_skill(tool_name: str, tool_input: object) -> bool:
    if tool_name != "Skill" or not isinstance(tool_input, dict):
        return False
    return str(tool_input.get("skill") or "").strip().lower() == "schedule"


@typechecked
def note_tool_used(session_id: str, tool_name: str, approved: bool) -> None:
    # Record which tools each step touched (in-memory; the executor/test path persists step_usage once at run end). Captures every tool the gate sees so a step's tool set is complete, not only the ones that prompted.
    mem = p_approval_memory.get(session_id)
    if mem is None or mem.current_step_id is None:
        return
    mem.step_usage.setdefault(mem.current_step_id, {})[tool_name] = approved


@typechecked
async def resolve_ask(
    ctx: HookContext, tool_name: str, tool_input: object, sensitive_pattern: Optional[str]
) -> ApprovalDecision:
    """Resolve an 'ask' policy. On a workflow run, reuse a remembered decision
    (this step first, then the workflow-level fallback) instead of prompting, and
    persist any fresh non-sensitive answer so later fires don't re-ask. Shared by
    both gates so they can't disagree (and so the first one's answer is reused by
    the second within the same call)."""
    mem = p_approval_memory.get(ctx.session_id)
    rememberable = (
        mem is not None
        and sensitive_pattern is None
        and tool_name != "AskUserQuestion"
    )
    if rememberable:
        sid = mem.current_step_id
        prior_step = mem.step_usage.get(sid, {}).get(tool_name) if sid is not None else None
        if prior_step is True:
            return ApprovalDecision(behavior="allow")
        if prior_step is False:
            return ApprovalDecision(behavior="deny", message="Denied by a remembered workflow permission")
        prior = mem.decisions.get(tool_name)
        if prior == "allow":
            note_tool_used(ctx.session_id, tool_name, True)
            return ApprovalDecision(behavior="allow")
        if prior == "deny":
            note_tool_used(ctx.session_id, tool_name, False)
            return ApprovalDecision(behavior="deny", message="Denied by a remembered workflow permission")
    timeout = mem.ask_timeout if mem is not None else 600.0
    decision = await request_user_approval(
        ctx.session, ctx.session_id, tool_name, tool_input, ctx.builtin_perms,
        sensitive_pattern=sensitive_pattern, timeout=timeout,
    )
    if rememberable and decision.behavior in ("allow", "deny"):
        behavior = decision.behavior
        mem.decisions[tool_name] = behavior
        note_tool_used(ctx.session_id, tool_name, behavior == "allow")
        if mem.remember:
            try:
                mem.remember(tool_name, behavior)
            except Exception:
                logger.exception("Failed to persist remembered workflow approval")
    return decision
