"""The SDK permission/pre-tool hooks, lifted out of the agent loop. can_use_tool answers the
SDK's permission callback; pre_tool_hook runs before each tool call and also carries the two
MCP loop-breakers (ToolSearch-thrash redirect + one-shot connect offer). Both operate on a
HookContext passed by reference, so the shared counters survive across calls. The dict returns
are the claude_agent_sdk hook protocol (hookSpecificOutput), not internal state."""

import asyncio
import logging
import time
from typing import Dict, Optional, Union

from typeguard import typechecked
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.settings.settings import load_settings
from backend.apps.agents.manager.permissions import path_gate
from backend.apps.agents.manager.permissions.decision import effective_policy
from backend.apps.agents.manager.prompt.tool_catalog import gated_mcp_server_names
from backend.apps.agents.manager.prompt.prompt_context import (
    TOOLSEARCH_LOOP_THRESHOLD,
    toolsearch_loop_redirect,
)
from backend.apps.agents.manager.streaming.HookContext import HookContext
from backend.apps.agents.manager.permissions.workflow_approval import (
    is_claude_schedule_skill,
    note_tool_used,
    resolve_ask,
)

logger = logging.getLogger(__name__)


@typechecked
async def can_use_tool(
    ctx: HookContext, tool_name: str, input_data: object, context: object
) -> Union[PermissionResultAllow, PermissionResultDeny]:
    if is_claude_schedule_skill(tool_name, input_data):
        note_tool_used(ctx.session_id, tool_name, False)
        return PermissionResultDeny(
            message="Use the openswarm-schedule MCP tools instead of Claude's internal schedule skill."
        )
    sensitive_pattern: Optional[str] = None
    if tool_name != "AskUserQuestion":
        policy, sensitive_pattern = path_gate.maybe_override_policy(
            effective_policy(tool_name, ctx.builtin_perms, ctx.policy_defaults), tool_name, input_data
        )
        if policy == "always_allow":
            note_tool_used(ctx.session_id, tool_name, True)
            return PermissionResultAllow(updated_input=input_data)
        if policy == "deny":
            note_tool_used(ctx.session_id, tool_name, False)
            return PermissionResultDeny(message="Tool denied by permission policy")

    decision = await resolve_ask(ctx, tool_name, input_data, sensitive_pattern)
    if decision.behavior == "allow":
        return PermissionResultAllow(
            updated_input=decision.updated_input if decision.updated_input is not None else input_data
        )
    return PermissionResultDeny(
        message=decision.message or "User denied this action"
    )


@typechecked
async def pre_tool_hook(ctx: HookContext, input_data: dict, tool_use_id: Optional[str], context: object) -> Dict[str, object]:
    tool_name = input_data.get("tool_name", "")
    hook_event = input_data.get("hook_event_name", "PreToolUse")

    # ToolSearch loop-breaker. Gated MCP servers are withheld from the SDK until MCPActivate, so the CLI's native ToolSearch can never find them; small models thrash (empty ToolSearch, retry) for minutes until the user pauses. Let the first couple through, then redirect to the gate. Any non-ToolSearch call is real progress, so the counter resets. Gated-server lookup is deferred behind the threshold so the common (non-looping) path stays free.
    if tool_name == "ToolSearch":
        ctx.ts_loop_count += 1
        if ctx.ts_loop_count >= TOOLSEARCH_LOOP_THRESHOLD:
            gated = gated_mcp_server_names(ctx.session.allowed_tools, ctx.session.active_mcps)
            reason = toolsearch_loop_redirect(ctx.ts_loop_count, gated)
            if reason:
                logger.info(f"[MCP-DEBUG] ToolSearch loop-breaker fired for {ctx.session_id} (n={ctx.ts_loop_count})")
                # 2B-MCP: also surface a one-click connect offer to the USER for the vetted gated servers the agent keeps reaching for. Suggest-only: this just shows a card on the same channel the preflight uses; activation still requires MCPActivate + the dispatch gate, so it opens no side channel. Once per run, fail-open (an offer hiccup must never block the agent).
                if not ctx.mcp_offer_sent:
                    try:
                        from backend.apps.agents.core.mcp_preflight import offer_for_gated_server
                        settings = load_settings()
                        offers = [o for o in (offer_for_gated_server(n, settings) for n in gated) if o]
                        if offers:
                            ctx.mcp_offer_sent = True
                            await ws_manager.send_to_session(ctx.session_id, "agent:mcp_suggestions", {
                                "session_id": ctx.session_id,
                                "suggestions": offers,
                                "is_vague": False,
                            })
                    except Exception:
                        logger.debug("mid-run MCP connect offer skipped", exc_info=True)
                return {
                    "hookSpecificOutput": {
                        "hookEventName": hook_event,
                        "permissionDecision": "deny",
                        "permissionDecisionReason": reason,
                    }
                }
    else:
        ctx.ts_loop_count = 0

    # MCPSearch is the agent saying "I need an integration I don't have" (e.g. "no email connected"). Don't make the user read a wall of options: fire the same curated connect card the launch preflight uses, keyed to their original request. Non-blocking (the search proceeds) and once per run; covers the common path the ToolSearch-loop branch misses because a capable model does one MCPSearch instead of thrashing. Suggest-only as ever.
    if (tool_name.endswith("MCPSearch") or tool_name.endswith("MCPList")) and not ctx.mcp_offer_sent:
        ctx.mcp_offer_sent = True

        async def offer_from_prompt():
            try:
                from backend.apps.agents.core.mcp_preflight import run_preflight
                result = await run_preflight(ctx.prompt, task_id=ctx.session_id, require_vague=False)
                offers = result.get("suggestions", [])
                if offers:
                    await ws_manager.send_to_session(ctx.session_id, "agent:mcp_suggestions", {
                        "session_id": ctx.session_id,
                        "suggestions": offers,
                        "is_vague": False,
                    })
            except Exception:
                logger.debug("MCPSearch-triggered connect offer skipped", exc_info=True)

        asyncio.create_task(offer_from_prompt())

    if tool_name and tool_name != "AskUserQuestion":
        tool_input = input_data.get("tool_input", {})
        if is_claude_schedule_skill(tool_name, tool_input):
            note_tool_used(ctx.session_id, tool_name, False)
            return {
                "hookSpecificOutput": {
                    "hookEventName": hook_event,
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "Use the openswarm-schedule MCP tools instead of Claude's internal schedule skill.",
                }
            }
        policy, sensitive_pattern = path_gate.maybe_override_policy(
            effective_policy(tool_name, ctx.builtin_perms, ctx.policy_defaults), tool_name, tool_input
        )

        if policy == "always_allow":
            note_tool_used(ctx.session_id, tool_name, True)

        if policy == "deny":
            note_tool_used(ctx.session_id, tool_name, False)
            return {
                "hookSpecificOutput": {
                    "hookEventName": hook_event,
                    "permissionDecision": "deny",
                    "permissionDecisionReason": "Tool denied by permission policy",
                }
            }

        if policy == "ask":
            decision = await resolve_ask(ctx, tool_name, tool_input, sensitive_pattern)

            if decision.behavior == "allow":
                if tool_use_id:
                    ctx.tool_start_times[tool_use_id] = time.time()
                return {
                    "hookSpecificOutput": {
                        "hookEventName": hook_event,
                        "permissionDecision": "allow",
                    }
                }
            return {
                "hookSpecificOutput": {
                    "hookEventName": hook_event,
                    "permissionDecision": "deny",
                    "permissionDecisionReason": decision.message or "User denied this action",
                }
            }

    if tool_use_id:
        ctx.tool_start_times[tool_use_id] = time.time()
    return {}
