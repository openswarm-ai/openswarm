"""Captured per-run state for the SDK tool hooks (can_use_tool / pre / post). Passed by
reference into the extracted hook functions so they can mutate the shared counters without
living inside the agent loop's closure. The session reference is the SAME object the loop
holds (pydantic keeps the instance, doesn't copy it), so hook-side mutations to status /
pending_approvals are visible to the loop."""

from typing import Dict

from pydantic import BaseModel, ConfigDict, InstanceOf

from backend.apps.agents.core.models import AgentSession


class HookContext(BaseModel):
    model_config = ConfigDict(validate_assignment=True)

    session: AgentSession
    session_id: str
    prompt: str
    builtin_perms: Dict[str, str]
    policy_defaults: Dict[str, str]
    # The manager's LIVE session registry (InstanceOf keeps the reference, so a sub-agent the post hook spawns is visible to the manager; a plain Dict field pydantic would copy).
    sessions: InstanceOf[dict]
    # tool_use_id -> wall-clock start (s); pre records it, post pops it for elapsed_ms.
    tool_start_times: Dict[str, float] = {}
    # Consecutive ToolSearch calls; a run of these is the "looping on ToolSearch" wedge.
    ts_loop_count: int = 0
    # One mid-run "connect this MCP" card per run; a stuck agent retries, the user sees it once.
    mcp_offer_sent: bool = False
