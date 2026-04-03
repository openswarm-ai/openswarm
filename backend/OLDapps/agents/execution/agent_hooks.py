"""SDK hook factories for the agent loop.

Creates the can_use_tool, pre_tool_hook, and post_tool_hook callables
required by ClaudeAgentOptions.
"""

from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime
from uuid import uuid4

from backend.apps.agents.models import AgentSession, Message
from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.agents.execution.approval import request_approval
from backend.apps.agents.execution.mcp_builder import get_effective_policy
from backend.apps.analytics.collector import record as _analytics
import asyncio

logger = logging.getLogger(__name__)


def create_sdk_hooks(
    session: AgentSession,
    session_id: str,
    sessions: dict[str, AgentSession],
    builtin_perms: dict,
    PermissionResultAllow,
    PermissionResultDeny,
):
    """Return (can_use_tool, pre_tool_hook, post_tool_hook) closures."""

    tool_start_times: dict[str, float] = {}

    async def _request_user_approval(tool_name: str, tool_input) -> dict:
        safe_input = tool_input if isinstance(tool_input, dict) else {}
        return await request_approval(session, tool_name, safe_input, track_analytics=True)

    async def can_use_tool(tool_name, input_data):
        if tool_name != "AskUserQuestion":
            policy = get_effective_policy(tool_name, builtin_perms)
            if policy == "always_allow":
                return PermissionResultAllow(updated_input=input_data)
            if policy == "deny":
                return PermissionResultDeny(message="Tool denied by permission policy")
        decision = await _request_user_approval(tool_name, input_data)
        if decision.get("behavior") == "allow":
            return PermissionResultAllow(updated_input=decision.get("updated_input", input_data))
        return PermissionResultDeny(message=decision.get("message", "User denied this action"))

    async def pre_tool_hook(input_data, tool_use_id):
        tool_name = input_data.get("tool_name", "")
        hook_event = input_data.get("hook_event_name", "PreToolUse")
        if tool_name and tool_name != "AskUserQuestion":
            policy = get_effective_policy(tool_name, builtin_perms)
            if policy == "deny":
                return {"hookSpecificOutput": {"hookEventName": hook_event, "permissionDecision": "deny", "permissionDecisionReason": "Tool denied by permission policy"}}
            if policy == "ask":
                tool_input = input_data.get("tool_input", {})
                decision = await _request_user_approval(tool_name, tool_input)
                if decision.get("behavior") == "allow":
                    if tool_use_id:
                        tool_start_times[tool_use_id] = time.time()
                    return {"hookSpecificOutput": {"hookEventName": hook_event, "permissionDecision": "allow"}}
                return {"hookSpecificOutput": {"hookEventName": hook_event, "permissionDecision": "deny", "permissionDecisionReason": decision.get("message", "User denied this action")}}
        if tool_use_id:
            tool_start_times[tool_use_id] = time.time()
        return {}

    async def post_tool_hook(input_data, tool_use_id):
        elapsed_ms = None
        if tool_use_id and tool_use_id in tool_start_times:
            elapsed_ms = int((time.time() - tool_start_times.pop(tool_use_id)) * 1000)

        raw_response = input_data.get("tool_response", "")

        hook_tool_name_early = input_data.get("tool_name", "")
        if hook_tool_name_early:
            _is_mcp = "__" in hook_tool_name_early
            _mcp_server = ""
            _tool_short = hook_tool_name_early
            if _is_mcp:
                _mcp_match = re.match(r"mcp__([^_]+(?:-[^_]+)*)__(.+)", hook_tool_name_early)
                if _mcp_match:
                    _mcp_server = _mcp_match.group(1)
                    _tool_short = _mcp_match.group(2)
            _analytics("tool.executed", {
                "tool_name": hook_tool_name_early, "tool_short_name": _tool_short,
                "tool_type": "mcp" if _is_mcp else "builtin", "mcp_server": _mcp_server,
                "duration_ms": elapsed_ms,
                "success": not (isinstance(raw_response, str) and raw_response.startswith("Error")),
                "model": session.model, "provider": session.provider,
            }, session_id=session_id, dashboard_id=session.dashboard_id)

        if isinstance(raw_response, list) and raw_response:
            text_parts = [b.get("text", "") for b in raw_response if isinstance(b, dict) and b.get("type") == "text"]
            if text_parts:
                raw_response = "\n".join(text_parts) if len(text_parts) > 1 else text_parts[0]

        if isinstance(raw_response, str):
            content = raw_response
        else:
            try:
                content = json.dumps(raw_response, indent=2, default=str)
            except Exception:
                content = str(raw_response)

        result_payload: dict = {"text": content}
        hook_tool_name = input_data.get("tool_name", "")
        if hook_tool_name:
            result_payload["tool_name"] = hook_tool_name
        if elapsed_ms is not None:
            result_payload["elapsed_ms"] = elapsed_ms

        if hook_tool_name == "Agent":
            sub_payload = _build_sub_agent_session(
                input_data, raw_response, content, session, session_id, sessions,
            )
            if sub_payload:
                result_payload["sub_session_id"] = sub_payload

        result_msg = Message(role="tool_result", content=result_payload, branch_id=session.active_branch_id)
        session.messages.append(result_msg)
        await ws_manager.emit_message(session_id, result_msg)
        return {"continue_": True}

    return can_use_tool, pre_tool_hook, post_tool_hook


async def _broadcast_sub_session(sub_session: AgentSession):
    await ws_manager.broadcast_global("agent:status", {
        "session_id": sub_session.id, "status": sub_session.status,
        "session": sub_session.model_dump(mode="json"),
    })


def _build_sub_agent_session(
    input_data: dict, raw_response, content: str,
    session: AgentSession, session_id: str,
    sessions: dict[str, AgentSession],
) -> str | None:
    """Create a sub-agent session from an Agent tool result. Returns sub_session_id or None."""
    tool_input = input_data.get("tool_input", {})
    agent_prompt = tool_input.get("prompt", tool_input.get("task", ""))
    sub_text = content
    sub_cost = 0.0
    sub_tokens: dict = {"input": 0, "output": 0}
    sub_model = session.model
    if isinstance(raw_response, dict):
        blocks = raw_response.get("content")
        if isinstance(blocks, list):
            parts = [b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"]
            if parts:
                sub_text = "\n".join(parts) if len(parts) > 1 else parts[0]
        elif isinstance(raw_response.get("text"), str):
            sub_text = raw_response["text"]
        usage = raw_response.get("usage", {})
        if isinstance(usage, dict):
            sub_tokens["input"] = usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0) + usage.get("cache_read_input_tokens", 0)
            sub_tokens["output"] = usage.get("output_tokens", 0)
        if raw_response.get("model"):
            sub_model = raw_response["model"]

    sub_session_id = uuid4().hex
    sub_name = agent_prompt[:50] if agent_prompt else "Sub-agent"
    sub_session = AgentSession(
        id=sub_session_id, name=sub_name, status="completed", model=sub_model,
        mode="sub-agent", cwd=session.cwd, created_at=datetime.now(),
        cost_usd=sub_cost, tokens=sub_tokens,
        messages=[
            Message(role="user", content=agent_prompt, branch_id="main"),
            Message(role="assistant", content=sub_text, branch_id="main"),
        ],
        dashboard_id=session.dashboard_id, parent_session_id=session_id,
    )
    sessions[sub_session_id] = sub_session
    asyncio.ensure_future(_broadcast_sub_session(sub_session))
    return sub_session_id
