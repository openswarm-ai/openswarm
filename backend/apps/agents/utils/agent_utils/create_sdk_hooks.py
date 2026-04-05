"""SDK hook factories for the agent loop.

create_sdk_hooks(agent) returns the three callables that ClaudeAgentOptions
expects: can_use_tool, pre_tool_hook, post_tool_hook.

All transport-specific behavior (WebSocket, persistence) is accessed
through Agent.emit (on_event) so this module stays framework-agnostic.
"""

import json
import time
from typing import Any, Callable, Dict, Tuple, Optional, List

from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny, PermissionResult

from backend.core.shared_structs.agent.Message.Message import ToolResultMessage
from backend.core.shared_structs.agent.Message.agent_outputs import ToolResultContent
from backend.core.events.events import AgentMessageEvent

from backend.core.Agent.Agent import Agent
from typeguard import typechecked
from backend.core.tools.shared_structs.TOOL_PERMISSIONS import TOOL_PERMISSIONS


@typechecked
def create_sdk_hooks(
    agent: "Agent",
) -> Tuple[Callable, Callable, Callable]:
    """Build (can_use_tool, pre_tool_hook, post_tool_hook) closures for an Agent."""

    tool_start_times: Dict[str, float] = {}

    @typechecked
    async def can_use_tool(tool_name: str, input_data: Any) -> PermissionResult:
        permission: Optional[TOOL_PERMISSIONS] = (
            agent.toolkit.resolve_permission(tool_name) if agent.toolkit else None
        )
        if permission == "allow":
            return PermissionResultAllow(updated_input=input_data)
        if permission == "deny":
            return PermissionResultDeny(message="Tool denied by permission policy")

        # TODO: better type spec for decision
        decision: Dict[str, Any] = await agent.request_approval(
            tool_name, input_data if isinstance(input_data, dict) else {},
        )
        if decision.get("behavior") == "allow":
            return PermissionResultAllow(
                updated_input=decision.get("updated_input", input_data),
            )
        return PermissionResultDeny(
            message=decision.get("message", "User denied this action"),
        )

    # TODO: better type spec for input_data and return value
    @typechecked
    async def pre_tool_hook(input_data: dict, tool_use_id: str) -> Dict[str, Any]:
        tool_name: str = input_data.get("tool_name", "")
        hook_event: str = input_data.get("hook_event_name", "PreToolUse")

        if tool_name:
            permission: Optional[TOOL_PERMISSIONS] = (
                agent.toolkit.resolve_permission(tool_name) if agent.toolkit else None
            )
            if permission == "deny":
                return {
                    "hookSpecificOutput": {
                        "hookEventName": hook_event,
                        "permissionDecision": "deny",
                        "permissionDecisionReason": "Tool denied by permission policy",
                    },
                }
            if permission == "ask":
                tool_input: Dict[str, Any] = input_data.get("tool_input", {})
                decision: Dict[str, Any] = await agent.request_approval(tool_name, tool_input)
                if decision.get("behavior") == "allow":
                    if tool_use_id:
                        tool_start_times[tool_use_id] = time.time()
                    return {
                        "hookSpecificOutput": {
                            "hookEventName": hook_event,
                            "permissionDecision": "allow",
                        },
                    }
                return {
                    "hookSpecificOutput": {
                        "hookEventName": hook_event,
                        "permissionDecision": "deny",
                        "permissionDecisionReason": decision.get(
                            "message", "User denied this action",
                        ),
                    },
                }

        if tool_use_id:
            tool_start_times[tool_use_id] = time.time()
        return {}

    @typechecked
    async def post_tool_hook(input_data: dict, tool_use_id: str) -> Dict[str, Any]:
        raw_response: str = input_data.get("tool_response", "")

        if isinstance(raw_response, list) and raw_response:
            text_parts: List[str] = [
                b.get("text", "")
                for b in raw_response
                if isinstance(b, dict) and b.get("type") == "text"
            ]
            if text_parts:
                raw_response: str = "\n".join(text_parts) if len(text_parts) > 1 else text_parts[0]

        if isinstance(raw_response, str):
            content: str = raw_response
        else:
            try:
                content: str = json.dumps(raw_response, indent=2, default=str)
            except Exception:
                content: str = str(raw_response)

        result_msg: ToolResultMessage = ToolResultMessage(
            content=ToolResultContent(
                tool_use_id=tool_use_id or "",
                text=content,
                is_error=isinstance(raw_response, str) and raw_response.startswith("Error"),
            ),
            branch_id=agent.branch_id,
        )
        agent.messages.append(result_msg)
        await agent.emit(AgentMessageEvent(
            session_id=agent.session_id, message=result_msg,
        ))

        return {"continue_": True}

    return can_use_tool, pre_tool_hook, post_tool_hook
