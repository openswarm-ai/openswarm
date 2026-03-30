"""Main agent loop — extracted from AgentManager._run_agent_loop.

Handles the Claude Agent SDK query loop, approval hooks, streaming,
mock-agent fallback, and session-completed analytics.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from datetime import datetime
from uuid import uuid4

from backend.apps.agents.models import AgentSession, ApprovalRequest, Message
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.agents.prompt_builder import (
    resolve_mode, compose_system_prompt, build_connected_tools_context,
    build_outputs_context, build_browser_context, build_prompt_content,
    get_pre_selected_browser_ids,
)
from backend.apps.agents.mcp_builder import (
    FULL_TOOLS, build_mcp_servers, get_effective_policy, get_all_tool_names,
    _get_denied_tool_names, _get_all_known_tool_names, _is_fully_denied,
)
from backend.apps.agents.session_store import save_session
from backend.apps.settings.settings import load_settings
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools,
    load_builtin_permissions,
)
from backend.apps.common.mcp_utils import sanitize_server_name as _sanitize_server_name
from backend.apps.analytics.collector import record as _analytics

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Streaming helpers
# ---------------------------------------------------------------------------

async def stream_text(session_id: str, msg_id: str, text: str, delay: float = 0.03):
    await ws_manager.send_to_session(session_id, "agent:stream_start", {
        "session_id": session_id, "message_id": msg_id, "role": "assistant",
    })
    words = text.split(" ")
    for i, word in enumerate(words):
        chunk = word if i == 0 else " " + word
        await ws_manager.send_to_session(session_id, "agent:stream_delta", {
            "session_id": session_id, "message_id": msg_id, "delta": chunk,
        })
        await asyncio.sleep(delay)
    await ws_manager.send_to_session(session_id, "agent:stream_end", {
        "session_id": session_id, "message_id": msg_id,
    })


async def stream_tool_input(session_id: str, msg_id: str, tool_name: str, input_json: str, delay: float = 0.02):
    await ws_manager.send_to_session(session_id, "agent:stream_start", {
        "session_id": session_id, "message_id": msg_id, "role": "tool_call", "tool_name": tool_name,
    })
    chunk_size = 12
    for i in range(0, len(input_json), chunk_size):
        await ws_manager.send_to_session(session_id, "agent:stream_delta", {
            "session_id": session_id, "message_id": msg_id, "delta": input_json[i:i + chunk_size],
        })
        await asyncio.sleep(delay)
    await ws_manager.send_to_session(session_id, "agent:stream_end", {
        "session_id": session_id, "message_id": msg_id,
    })


# ---------------------------------------------------------------------------
# Analytics helper
# ---------------------------------------------------------------------------

def fire_session_completed(session: AgentSession, sessions_dict: dict[str, AgentSession]):
    duration = 0.0
    if session.created_at:
        end = session.closed_at or datetime.now()
        duration = (end - session.created_at).total_seconds()
    tool_names = [
        m.content.get("tool", "") for m in session.messages
        if m.role == "tool_call" and isinstance(m.content, dict)
    ]
    user_messages = [
        (m.content if isinstance(m.content, str) else str(m.content))[:200]
        for m in session.messages if m.role == "user"
    ]
    _analytics("session.completed", {
        "model": session.model,
        "provider": getattr(session, "provider", "anthropic"),
        "mode": session.mode,
        "cost_usd": session.cost_usd,
        "message_count": len([m for m in session.messages if m.role in ("user", "assistant")]),
        "duration_seconds": round(duration, 1),
        "status": session.status,
        "tool_count": len(tool_names),
        "tools_list": list(set(tool_names)),
        "session_title": session.name,
        "first_user_message": user_messages[0] if user_messages else "",
        "input_tokens": session.tokens.get("input", 0),
        "output_tokens": session.tokens.get("output", 0),
        "is_sub_agent": session.parent_session_id is not None,
        "parent_session_id": session.parent_session_id,
        "sub_agent_count": len([s for s in sessions_dict.values() if s.parent_session_id == session.id]),
        "branch_count": len(session.branches),
    }, session_id=session.id, dashboard_id=session.dashboard_id)


# ---------------------------------------------------------------------------
# Mock agent
# ---------------------------------------------------------------------------

async def run_mock_agent(session_id: str, prompt: str, sessions: dict[str, AgentSession]):
    session = sessions.get(session_id)
    if not session:
        return

    await asyncio.sleep(1)

    request_id = uuid4().hex
    approval_req = ApprovalRequest(
        id=request_id, session_id=session_id, tool_name="Bash",
        tool_input={"command": f"echo 'Processing: {prompt}'", "description": "Echo the user prompt"},
    )
    session.pending_approvals.append(approval_req)
    session.status = "waiting_approval"
    await ws_manager.send_to_session(session_id, "agent:status", {
        "session_id": session_id, "status": "waiting_approval",
    })

    decision = await ws_manager.send_approval_request(
        session_id, request_id, "Bash",
        {"command": f"echo 'Processing: {prompt}'", "description": "Echo the user prompt"},
    )

    session.pending_approvals = [a for a in session.pending_approvals if a.id != request_id]
    session.status = "running"
    await ws_manager.send_to_session(session_id, "agent:status", {
        "session_id": session_id, "status": "running",
    })

    tool_input_content = {"tool": "Bash", "input": {"command": f"echo 'Processing: {prompt}'"}, "approved": decision.get("behavior") == "allow"}
    tool_msg_id = uuid4().hex
    await stream_tool_input(session_id, tool_msg_id, "Bash", json.dumps(tool_input_content["input"], indent=2))
    tool_msg = Message(id=tool_msg_id, role="tool_call", content=tool_input_content, branch_id=session.active_branch_id)
    session.messages.append(tool_msg)
    await ws_manager.send_to_session(session_id, "agent:message", {
        "session_id": session_id, "message": tool_msg.model_dump(mode="json"),
    })

    await asyncio.sleep(1)

    if decision.get("behavior") == "allow":
        tool_result = Message(role="tool_result", content=f"Processing: {prompt}", branch_id=session.active_branch_id)
        session.messages.append(tool_result)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id, "message": tool_result.model_dump(mode="json"),
        })

    await asyncio.sleep(1)

    asst_text = (
        f"I've processed your request: \"{prompt}\"\n\n"
        "This is a mock response because `claude-agent-sdk` is not installed. "
        "Install it with `pip install claude-agent-sdk` to use real Claude Code instances.\n\n"
        f"The agent was configured with:\n- Model: {session.model}\n- Mode: {session.mode}"
    )
    asst_msg_id = uuid4().hex
    await stream_text(session_id, asst_msg_id, asst_text)

    asst_msg = Message(id=asst_msg_id, role="assistant", content=asst_text, branch_id=session.active_branch_id)
    session.messages.append(asst_msg)
    await ws_manager.send_to_session(session_id, "agent:message", {
        "session_id": session_id, "message": asst_msg.model_dump(mode="json"),
    })

    session.status = "completed"
    session.closed_at = datetime.now()
    session.cost_usd = 0.001
    await ws_manager.send_to_session(session_id, "agent:status", {
        "session_id": session_id, "status": "completed",
        "session": session.model_dump(mode="json"),
    })
    await ws_manager.send_to_session(session_id, "agent:cost_update", {
        "session_id": session_id, "cost_usd": session.cost_usd,
    })


# ---------------------------------------------------------------------------
# Main agent loop
# ---------------------------------------------------------------------------

async def run_agent_loop(
    sessions: dict[str, AgentSession],
    session_id: str,
    prompt: str,
    images: list | None = None,
    context_paths: list | None = None,
    forced_tools: list[str] | None = None,
    attached_skills: list | None = None,
    fork_session: bool = False,
    selected_browser_ids: list[str] | None = None,
):
    """Run the Claude Agent SDK query loop for a session."""
    session = sessions.get(session_id)
    if not session:
        return

    prompt_content = build_prompt_content(
        prompt, images, context_paths, forced_tools, attached_skills,
        load_all_tools_fn=load_all_tools,
    )

    try:
        from claude_agent_sdk import (
            query, ClaudeAgentOptions, AssistantMessage, ResultMessage,
        )
        from claude_agent_sdk.types import (
            HookMatcher, PermissionResultAllow, PermissionResultDeny,
            TextBlock, ToolUseBlock, StreamEvent,
            SystemMessage,
        )
    except ImportError:
        logger.warning("claude_agent_sdk not installed, running in mock mode")
        await run_mock_agent(session_id, prompt, sessions)
        return

    session.status = "running"
    _builtin_perms = load_builtin_permissions()

    async def _request_user_approval(tool_name: str, tool_input) -> dict:
        safe_input = tool_input if isinstance(tool_input, dict) else {}
        request_id = uuid4().hex
        approval_req = ApprovalRequest(
            id=request_id, session_id=session_id, tool_name=tool_name, tool_input=safe_input,
        )
        session.pending_approvals.append(approval_req)
        session.status = "waiting_approval"

        _analytics("approval.requested", {
            "tool_name": tool_name,
            "is_first_approval_in_session": len(session.pending_approvals) == 1,
            "model": session.model,
        }, session_id=session_id, dashboard_id=session.dashboard_id)

        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id, "status": "waiting_approval",
        })

        decision = await ws_manager.send_approval_request(
            session_id, request_id, tool_name, safe_input,
        )

        approval_latency_ms = int((datetime.now() - approval_req.created_at).total_seconds() * 1000)
        _analytics("approval.resolved", {
            "tool_name": tool_name,
            "decision": decision.get("behavior", "unknown"),
            "latency_ms": approval_latency_ms,
            "input_was_modified": decision.get("updated_input") is not None,
            "model": session.model,
        }, session_id=session_id, dashboard_id=session.dashboard_id)

        session.pending_approvals = [a for a in session.pending_approvals if a.id != request_id]
        session.status = "running"
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id, "status": "running",
        })
        return decision

    async def can_use_tool(tool_name, input_data, context):
        if tool_name != "AskUserQuestion":
            policy = get_effective_policy(tool_name, _builtin_perms)
            if policy == "always_allow":
                return PermissionResultAllow(updated_input=input_data)
            if policy == "deny":
                return PermissionResultDeny(message="Tool denied by permission policy")
        decision = await _request_user_approval(tool_name, input_data)
        if decision.get("behavior") == "allow":
            return PermissionResultAllow(updated_input=decision.get("updated_input", input_data))
        return PermissionResultDeny(message=decision.get("message", "User denied this action"))

    tool_start_times: dict[str, float] = {}

    async def pre_tool_hook(input_data, tool_use_id, context):
        tool_name = input_data.get("tool_name", "")
        hook_event = input_data.get("hook_event_name", "PreToolUse")
        if tool_name and tool_name != "AskUserQuestion":
            policy = get_effective_policy(tool_name, _builtin_perms)
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

    async def post_tool_hook(input_data, tool_use_id, context):
        import re as _re_tool
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
                _mcp_match = _re_tool.match(r"mcp__([^_]+(?:-[^_]+)*)__(.+)", hook_tool_name_early)
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
            await ws_manager.broadcast_global("agent:status", {
                "session_id": sub_session_id, "status": sub_session.status,
                "session": sub_session.model_dump(mode="json"),
            })
            result_payload["sub_session_id"] = sub_session_id

        result_msg = Message(role="tool_result", content=result_payload, branch_id=session.active_branch_id)
        session.messages.append(result_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id, "message": result_msg.model_dump(mode="json"),
        })
        return {"continue_": True}

    try:
        _, mode_sys_prompt, _ = resolve_mode(session.mode, get_all_tool_names)
        connected_tools_ctx = build_connected_tools_context(
            session.allowed_tools, load_all_tools, get_all_tool_names, _is_fully_denied, _get_denied_tool_names,
        )
        outputs_ctx = build_outputs_context()
        browser_ctx = build_browser_context(session.dashboard_id, selected_browser_ids=selected_browser_ids)
        global_settings = load_settings()
        composed_prompt = compose_system_prompt(
            global_settings.default_system_prompt, mode_sys_prompt, session.system_prompt,
            connected_tools_ctx, outputs_ctx, browser_ctx,
        )

        if session.mode == "view-builder":
            from backend.apps.outputs.view_builder_templates import VIEW_BUILDER_SKILL
            skill_block = f"<app_builder_reference>\n{VIEW_BUILDER_SKILL}\n</app_builder_reference>"
            composed_prompt = f"{composed_prompt}\n\n{skill_block}" if composed_prompt else skill_block

        mcp_servers = await build_mcp_servers(session.allowed_tools)

        _browser_delegation_tools = ["CreateBrowserAgent", "BrowserAgent", "BrowserAgents"]
        _browser_all_denied = all(_builtin_perms.get(t, "always_allow") == "deny" for t in _browser_delegation_tools)

        if not _browser_all_denied:
            browser_agent_server_path = os.path.join(os.path.dirname(__file__), "browser_agent_mcp_server.py")
            backend_port = os.environ.get("OPENSWARM_PORT", "8324")
            pre_selected_bids = get_pre_selected_browser_ids(session.dashboard_id)
            mcp_servers["openswarm-browser-agent"] = {
                "command": sys.executable,
                "args": [browser_agent_server_path],
                "env": {
                    "OPENSWARM_PORT": backend_port,
                    "OPENSWARM_AGENT_MODEL": session.model,
                    "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
                    "OPENSWARM_PRE_SELECTED_BROWSER_IDS": ",".join(pre_selected_bids),
                    "OPENSWARM_PARENT_SESSION_ID": session.id,
                },
                "type": "stdio",
            }

        _invoke_agent_tools = ["InvokeAgent"]
        _invoke_all_denied = all(_builtin_perms.get(t, "always_allow") == "deny" for t in _invoke_agent_tools)

        if not _invoke_all_denied:
            invoke_agent_server_path = os.path.join(os.path.dirname(__file__), "invoke_agent_mcp_server.py")
            backend_port = os.environ.get("OPENSWARM_PORT", "8324")
            mcp_servers["openswarm-invoke-agent"] = {
                "command": sys.executable,
                "args": [invoke_agent_server_path],
                "env": {
                    "OPENSWARM_PORT": backend_port,
                    "OPENSWARM_PARENT_SESSION_ID": session.id,
                    "OPENSWARM_DASHBOARD_ID": session.dashboard_id or "",
                },
                "type": "stdio",
            }

        effective_allowed = [
            t for t in session.allowed_tools
            if t in FULL_TOOLS and _builtin_perms.get(t, "always_allow") == "always_allow"
        ]
        effective_disallowed = [
            t for t in FULL_TOOLS
            if _builtin_perms.get(t, "always_allow") == "deny"
        ]

        if mcp_servers:
            all_tools_list = load_all_tools()
            for name in mcp_servers:
                if name == "openswarm-browser-agent":
                    for bt in _browser_delegation_tools:
                        policy = _builtin_perms.get(bt, "always_allow")
                        if policy == "always_allow":
                            effective_allowed.append(f"mcp__openswarm-browser-agent__{bt}")
                        elif policy == "deny":
                            effective_disallowed.append(f"mcp__openswarm-browser-agent__{bt}")
                    continue
                if name == "openswarm-invoke-agent":
                    for it in _invoke_agent_tools:
                        policy = _builtin_perms.get(it, "always_allow")
                        if policy == "always_allow":
                            effective_allowed.append(f"mcp__openswarm-invoke-agent__{it}")
                        elif policy == "deny":
                            effective_disallowed.append(f"mcp__openswarm-invoke-agent__{it}")
                    continue
                tool_def = next(
                    (t for t in all_tools_list if t.mcp_config and t.enabled and _sanitize_server_name(t.name) == name),
                    None,
                )
                if tool_def:
                    denied = _get_denied_tool_names(tool_def)
                    known = _get_all_known_tool_names(tool_def)
                    for tn in known - denied:
                        policy = tool_def.tool_permissions.get(tn, "ask")
                        if policy == "always_allow":
                            effective_allowed.append(f"mcp__{name}__{tn}")
                    for tn in denied:
                        effective_disallowed.append(f"mcp__{name}__{tn}")
                else:
                    effective_allowed.append(f"mcp__{name}__*")

        google_allowed = [t for t in effective_allowed if "google-workspace" in t]
        reddit_allowed = [t for t in effective_allowed if "reddit" in t]
        builtin_allowed = [t for t in effective_allowed if not t.startswith("mcp__")]
        logger.info(f"[MCP-DEBUG] effective_allowed: {len(effective_allowed)} total "
                    f"(builtins={len(builtin_allowed)}, google={len(google_allowed)}, reddit={len(reddit_allowed)})")
        if effective_disallowed:
            logger.info(f"[MCP-DEBUG] effective_disallowed: {effective_disallowed}")

        options_kwargs: dict = {
            "model": session.model,
            "max_buffer_size": 5 * 1024 * 1024,
            "permission_mode": "default",
            "can_use_tool": can_use_tool,
            "hooks": {
                "PreToolUse": [HookMatcher(matcher=None, hooks=[pre_tool_hook])],
                "PostToolUse": [HookMatcher(matcher=None, hooks=[post_tool_hook])],
            },
            "allowed_tools": effective_allowed,
            "disallowed_tools": effective_disallowed,
            "include_partial_messages": True,
        }

        from backend.apps.nine_router import is_running as _9r_running
        if global_settings.anthropic_api_key:
            options_kwargs["env"] = {"ANTHROPIC_API_KEY": global_settings.anthropic_api_key}
            logger.info("[MCP-DEBUG] Using direct API key")
        elif _9r_running():
            options_kwargs["env"] = {
                "ANTHROPIC_API_KEY": "9router",
                "ANTHROPIC_BASE_URL": "http://localhost:20128",
            }
            options_kwargs["extra_args"] = {"bare": None}
            logger.info("[MCP-DEBUG] Using 9Router (bare mode)")
        else:
            raise ValueError("No AI provider configured. Set an API key or connect a subscription.")

        if mcp_servers:
            options_kwargs["mcp_servers"] = mcp_servers
            mcp_json_len = len(json.dumps({"mcpServers": mcp_servers}))
            logger.info(f"[MCP-DEBUG] mcp_servers passed to SDK: {list(mcp_servers.keys())}, JSON length={mcp_json_len}")
        if composed_prompt:
            options_kwargs["system_prompt"] = composed_prompt
        if session.max_turns:
            options_kwargs["max_turns"] = session.max_turns
        if session.cwd:
            options_kwargs["cwd"] = session.cwd
        if session.sdk_session_id:
            options_kwargs["resume"] = session.sdk_session_id
            if fork_session:
                options_kwargs["fork_session"] = True

        logger.info(f"[MCP-DEBUG] Creating ClaudeAgentOptions with model={session.model}")
        options = ClaudeAgentOptions(**options_kwargs)
        logger.info("[MCP-DEBUG] ClaudeAgentOptions created. Starting query...")

        async def prompt_stream():
            yield {"type": "user", "message": {"role": "user", "content": prompt_content}}

        stream_text_msg_id = None
        stream_tool_msg_ids_ordered: list[str] = []
        stream_block_index_map: dict[int, str] = {}
        _turn_number = 0
        _first_event = True

        async for message in query(prompt=prompt_stream(), options=options):
            if _first_event:
                logger.info(f"[MCP-DEBUG] First event received: {type(message).__name__}")
                _first_event = False

            if isinstance(message, SystemMessage):
                raw = message.__dict__ if hasattr(message, '__dict__') else str(message)
                logger.info(f"[MCP-DEBUG] SystemMessage: {raw}")

            if isinstance(message, StreamEvent):
                event = message.event
                event_type = event.get("type")

                if event_type == "content_block_start":
                    block = event.get("content_block", {})
                    index = event.get("index")
                    block_type = block.get("type")
                    if block_type == "text":
                        if stream_text_msg_id is None:
                            stream_text_msg_id = uuid4().hex
                            await ws_manager.send_to_session(session_id, "agent:stream_start", {
                                "session_id": session_id, "message_id": stream_text_msg_id, "role": "assistant",
                            })
                        stream_block_index_map[index] = stream_text_msg_id
                    elif block_type == "tool_use":
                        tool_msg_id = uuid4().hex
                        stream_tool_msg_ids_ordered.append(tool_msg_id)
                        stream_block_index_map[index] = tool_msg_id
                        await ws_manager.send_to_session(session_id, "agent:stream_start", {
                            "session_id": session_id, "message_id": tool_msg_id,
                            "role": "tool_call", "tool_name": block.get("name", ""),
                        })

                elif event_type == "content_block_delta":
                    index = event.get("index")
                    delta = event.get("delta", {})
                    delta_type = delta.get("type")
                    msg_id = stream_block_index_map.get(index)
                    if msg_id and delta_type == "text_delta":
                        await ws_manager.send_to_session(session_id, "agent:stream_delta", {
                            "session_id": session_id, "message_id": msg_id, "delta": delta.get("text", ""),
                        })
                    elif msg_id and delta_type == "input_json_delta":
                        await ws_manager.send_to_session(session_id, "agent:stream_delta", {
                            "session_id": session_id, "message_id": msg_id, "delta": delta.get("partial_json", ""),
                        })

                elif event_type == "content_block_stop":
                    index = event.get("index")
                    msg_id = stream_block_index_map.get(index)
                    if msg_id and msg_id != stream_text_msg_id:
                        await ws_manager.send_to_session(session_id, "agent:stream_end", {
                            "session_id": session_id, "message_id": msg_id,
                        })

                elif event_type == "message_stop":
                    if stream_text_msg_id:
                        await ws_manager.send_to_session(session_id, "agent:stream_end", {
                            "session_id": session_id, "message_id": stream_text_msg_id,
                        })

            elif isinstance(message, AssistantMessage):
                content_parts = []
                tool_uses = []
                for block in message.content:
                    if isinstance(block, TextBlock):
                        content_parts.append(block.text)
                    elif isinstance(block, ToolUseBlock):
                        tool_uses.append({"id": block.id, "tool": block.name, "input": block.input})

                if content_parts:
                    asst_msg = Message(
                        id=stream_text_msg_id or uuid4().hex,
                        role="assistant", content="\n".join(content_parts),
                        branch_id=session.active_branch_id,
                    )
                    session.messages.append(asst_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id, "message": asst_msg.model_dump(mode="json"),
                    })

                for i, tu in enumerate(tool_uses):
                    mid = stream_tool_msg_ids_ordered[i] if i < len(stream_tool_msg_ids_ordered) else uuid4().hex
                    tool_msg = Message(id=mid, role="tool_call", content=tu, branch_id=session.active_branch_id)
                    session.messages.append(tool_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id, "message": tool_msg.model_dump(mode="json"),
                    })

                _turn_number += 1
                _analytics("turn.completed", {
                    "turn_number": _turn_number, "tool_calls_in_turn": len(tool_uses), "model": session.model,
                }, session_id=session_id, dashboard_id=session.dashboard_id)

                stream_text_msg_id = None
                stream_tool_msg_ids_ordered = []
                stream_block_index_map = {}

            elif isinstance(message, ResultMessage):
                session.sdk_session_id = getattr(message, "session_id", None)
                cost = getattr(message, "total_cost_usd", None)
                if cost is not None:
                    session.cost_usd = cost
                    await ws_manager.send_to_session(session_id, "agent:cost_update", {
                        "session_id": session_id, "cost_usd": session.cost_usd,
                    })
                usage = getattr(message, "usage", None) or {}
                if isinstance(usage, dict):
                    inp = usage.get("input_tokens", 0) or 0
                    out = usage.get("output_tokens", 0) or 0
                    cache_create = usage.get("cache_creation_input_tokens", 0) or 0
                    cache_read = usage.get("cache_read_input_tokens", 0) or 0
                    session.tokens["input"] = inp + cache_create + cache_read
                    session.tokens["output"] = out

        session.status = "completed"
    except asyncio.CancelledError:
        session.status = "stopped"
    except Exception as e:
        logger.exception(f"Agent {session_id} error: {e}")
        session.status = "error"
        _analytics("session.error", {
            "error_type": type(e).__name__, "error_message": str(e)[:500],
            "model": session.model, "provider": session.provider, "mode": session.mode,
        }, session_id=session_id, dashboard_id=session.dashboard_id)
        error_msg = Message(role="system", content=f"Error: {str(e)}", branch_id=session.active_branch_id)
        session.messages.append(error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id, "message": error_msg.model_dump(mode="json"),
        })
    finally:
        if session_id in sessions:
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id, "status": session.status,
                "session": session.model_dump(mode="json"),
            })
            try:
                save_session(session_id, session.model_dump(mode="json"))
            except Exception as e:
                logger.warning(f"Failed to snapshot session {session_id}: {e}")
