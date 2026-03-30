"""Main agent loop — orchestrates the Claude Agent SDK query loop.

Heavy logic is delegated to sibling modules:
- agent_mock       – mock-agent fallback, streaming helpers, session analytics
- agent_hooks      – SDK hook factories (approval, permissions, post-tool)
- agent_options    – MCP server construction & ClaudeAgentOptions building
"""

from __future__ import annotations

import asyncio
import logging
from uuid import uuid4

from backend.apps.agents.models import AgentSession, Message
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.agents.session_store import save_session
from backend.apps.agents.prompt_builder import build_prompt_content
from backend.apps.tools_lib.tools_lib import (
    _load_all as load_all_tools,
    load_builtin_permissions,
)
from backend.apps.analytics.collector import record as _analytics
from backend.apps.agents.agent_mock import run_mock_agent, fire_session_completed

logger = logging.getLogger(__name__)


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
            TextBlock, ToolUseBlock, StreamEvent, SystemMessage,
        )
    except ImportError:
        logger.warning("claude_agent_sdk not installed, running in mock mode")
        await run_mock_agent(session_id, prompt, sessions)
        return

    session.status = "running"
    builtin_perms = load_builtin_permissions()

    from backend.apps.agents.agent_hooks import create_sdk_hooks
    can_use_tool, pre_tool_hook, post_tool_hook = create_sdk_hooks(
        session, session_id, sessions, builtin_perms,
        PermissionResultAllow, PermissionResultDeny,
    )

    from backend.apps.agents.agent_options import build_agent_options

    try:
        options_kwargs = await build_agent_options(
            session, builtin_perms, can_use_tool, pre_tool_hook, post_tool_hook,
            fork_session=fork_session, selected_browser_ids=selected_browser_ids,
        )
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
                stream_text_msg_id = await _handle_stream_event(
                    session_id, message.event,
                    stream_text_msg_id, stream_tool_msg_ids_ordered, stream_block_index_map,
                )

            elif isinstance(message, AssistantMessage):
                stream_text_msg_id, stream_tool_msg_ids_ordered, stream_block_index_map = (
                    await _handle_assistant_message(
                        session, session_id, message, stream_text_msg_id,
                        stream_tool_msg_ids_ordered, _turn_number,
                        TextBlock, ToolUseBlock,
                    )
                )
                _turn_number += 1

            elif isinstance(message, ResultMessage):
                await _handle_result_message(session, session_id, message)

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
        await ws_manager.emit_message(session_id, error_msg)
    finally:
        if session_id in sessions:
            await ws_manager.emit_status(session_id, session.status, session)
            try:
                save_session(session_id, session.model_dump(mode="json"))
            except Exception as e:
                logger.warning(f"Failed to snapshot session {session_id}: {e}")


async def _handle_stream_event(
    session_id: str, event: dict,
    stream_text_msg_id: str | None,
    stream_tool_ids: list[str],
    block_map: dict[int, str],
) -> str | None:
    """Process a single StreamEvent and return the (possibly updated) text msg id."""
    event_type = event.get("type")

    if event_type == "content_block_start":
        block = event.get("content_block", {})
        index = event.get("index")
        if block.get("type") == "text":
            if stream_text_msg_id is None:
                stream_text_msg_id = uuid4().hex
                await ws_manager.emit_stream_start(session_id, stream_text_msg_id, "assistant")
            block_map[index] = stream_text_msg_id
        elif block.get("type") == "tool_use":
            tool_msg_id = uuid4().hex
            stream_tool_ids.append(tool_msg_id)
            block_map[index] = tool_msg_id
            await ws_manager.emit_stream_start(session_id, tool_msg_id, "tool_call", tool_name=block.get("name", ""))

    elif event_type == "content_block_delta":
        index = event.get("index")
        delta = event.get("delta", {})
        msg_id = block_map.get(index)
        if msg_id:
            delta_type = delta.get("type")
            if delta_type == "text_delta":
                await ws_manager.emit_stream_delta(session_id, msg_id, delta.get("text", ""))
            elif delta_type == "input_json_delta":
                await ws_manager.emit_stream_delta(session_id, msg_id, delta.get("partial_json", ""))

    elif event_type == "content_block_stop":
        msg_id = block_map.get(event.get("index"))
        if msg_id and msg_id != stream_text_msg_id:
            await ws_manager.emit_stream_end(session_id, msg_id)

    elif event_type == "message_stop":
        if stream_text_msg_id:
            await ws_manager.emit_stream_end(session_id, stream_text_msg_id)

    return stream_text_msg_id


async def _handle_assistant_message(
    session, session_id, message, stream_text_msg_id,
    stream_tool_ids, turn_number, TextBlock, ToolUseBlock,
):
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
        await ws_manager.emit_message(session_id, asst_msg)

    for i, tu in enumerate(tool_uses):
        mid = stream_tool_ids[i] if i < len(stream_tool_ids) else uuid4().hex
        tool_msg = Message(id=mid, role="tool_call", content=tu, branch_id=session.active_branch_id)
        session.messages.append(tool_msg)
        await ws_manager.emit_message(session_id, tool_msg)

    _analytics("turn.completed", {
        "turn_number": turn_number + 1, "tool_calls_in_turn": len(tool_uses), "model": session.model,
    }, session_id=session_id, dashboard_id=session.dashboard_id)

    return None, [], {}


async def _handle_result_message(session, session_id, message):
    session.sdk_session_id = getattr(message, "session_id", None)
    cost = getattr(message, "total_cost_usd", None)
    if cost is not None:
        session.cost_usd = cost
        await ws_manager.emit_cost_update(session_id, session.cost_usd)
    usage = getattr(message, "usage", None) or {}
    if isinstance(usage, dict):
        inp = usage.get("input_tokens", 0) or 0
        out = usage.get("output_tokens", 0) or 0
        cache_create = usage.get("cache_creation_input_tokens", 0) or 0
        cache_read = usage.get("cache_read_input_tokens", 0) or 0
        session.tokens["input"] = inp + cache_create + cache_read
        session.tokens["output"] = out
