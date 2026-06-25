"""The SDK PostToolUse hook, lifted out of the agent loop. Runs after every tool call:
records per-tool latency, normalizes the raw tool response into displayable text, re-renders
view-builder writes (and drains build errors), materializes a spawned Agent sub-session into
the manager registry, spills oversized results to disk, and broadcasts the tool_result message.
Operates on the HookContext (its `sessions` is the manager's live registry). The dict returns
and payloads are the SDK hook protocol / existing message shapes, not internal models."""

import asyncio
import logging
import time
from datetime import datetime
from typing import Dict
from uuid import uuid4

from typeguard import typechecked

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.apply_context_window import apply_context_window
from backend.apps.agents.manager.session.history_compaction import (
    truncate_large_tool_result,
    wrap_platform_note,
    strip_forged_sentinels,
)
from backend.apps.agents.manager.streaming.HookContext import HookContext
from backend.apps.agents.manager.view_builder_state import view_builder_dirty_sessions

logger = logging.getLogger(__name__)


@typechecked
async def post_tool_hook(ctx: HookContext, input_data: dict, tool_use_id, context) -> Dict[str, object]:
    session = ctx.session
    session_id = ctx.session_id

    elapsed_ms = None
    if tool_use_id and tool_use_id in ctx.tool_start_times:
        elapsed_ms = int((time.time() - ctx.tool_start_times.pop(tool_use_id)) * 1000)

    raw_response = input_data.get("tool_response", "")

    # Accumulate per-tool latency on the session. Lets the cloud aggregate a tool-latency distribution into the existing daily.summary without firing per-tool events.
    hook_tool_name_early = input_data.get("tool_name", "")
    if hook_tool_name_early and elapsed_ms is not None and elapsed_ms >= 0:
        latencies = getattr(session, "tool_latencies", None)
        if latencies is None:
            latencies = {}
            try:
                session.tool_latencies = latencies
            except Exception:
                latencies = None
        if latencies is not None:
            slot = latencies.get(hook_tool_name_early)
            if slot is None:
                slot = {"count": 0, "total_ms": 0, "max_ms": 0}
                latencies[hook_tool_name_early] = slot
            slot["count"] = slot.get("count", 0) + 1
            slot["total_ms"] = slot.get("total_ms", 0) + elapsed_ms
            slot["max_ms"] = max(slot.get("max_ms", 0), elapsed_ms)

    if isinstance(raw_response, list) and raw_response:
        text_parts = [
            block.get("text", "")
            for block in raw_response
            if isinstance(block, dict) and block.get("type") == "text"
        ]
        if text_parts:
            raw_response = "\n".join(text_parts) if len(text_parts) > 1 else text_parts[0]

    if isinstance(raw_response, str):
        content = raw_response
    else:
        try:
            import json as json_lib
            content = json_lib.dumps(raw_response, indent=2, default=str)
        except Exception:
            content = str(raw_response)

    # Untrusted tool output could forge our trusted-note tag; neuter it before we append real ones below.
    content = strip_forged_sentinels(content)

    hook_tool_name_for_errors = input_data.get("tool_name", "")
    wrote_files = hook_tool_name_for_errors in ("Write", "Edit", "MultiEdit")
    tool_in = input_data.get("tool_input") or {}
    file_path = tool_in.get("file_path") or tool_in.get("path") or ""
    wrote_frontend_file = wrote_files and "/frontend/" in file_path
    installed_pkg = False
    if hook_tool_name_for_errors == "Bash":
        bash_in = input_data.get("tool_input") or {}
        cmd = (bash_in.get("command") or "").lower()
        installed_pkg = any(s in cmd for s in (
            "npm install", "npm i ", "npm uninstall", "npm ci",
            "pnpm add", "pnpm install", "pnpm remove",
            "yarn add", "yarn install", "yarn remove",
        ))

    if session.mode == "view-builder" and (wrote_frontend_file or installed_pkg):
        view_builder_dirty_sessions.add(session.id)
        try:
            from backend.apps.outputs.runtime import (
                manager as outputs_runtime_manager,
            )
            outputs_runtime_manager.reset_render_state_for_workspace(session.id)
        except Exception:
            pass
    elif wrote_files:
        if file_path:
            try:
                await asyncio.sleep(0.4)
                from backend.apps.outputs.runtime import (
                    manager as outputs_runtime_manager,
                )
                errs = outputs_runtime_manager.drain_errors_for_path(file_path)
            except Exception:
                errs = []
            if errs:
                joined = "\n".join(errs[-20:])
                content = (
                    f"{content}\n\n"
                    + wrap_platform_note(f"Build server reported (after this write):\n{joined}")
                )

    result_payload = {"text": content}
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
        sub_tokens = {"input": 0, "output": 0}
        sub_model = session.model
        if isinstance(raw_response, dict):
            blocks = raw_response.get("content")
            if isinstance(blocks, list):
                parts = [
                    b.get("text", "")
                    for b in blocks
                    if isinstance(b, dict) and b.get("type") == "text"
                ]
                if parts:
                    sub_text = "\n".join(parts) if len(parts) > 1 else parts[0]
            elif isinstance(raw_response.get("text"), str):
                sub_text = raw_response["text"]
            usage = raw_response.get("usage", {})
            if isinstance(usage, dict):
                sub_tokens["input"] = usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0) + usage.get("cache_read_input_tokens", 0)
                # Pill-only lane: NEW (uncached) input, excludes the cached static prefix so the bubble shows what this turn added.
                sub_tokens["input_fresh"] = usage.get("input_tokens", 0)
                sub_tokens["output"] = usage.get("output_tokens", 0)
            if raw_response.get("total_cost_usd"):
                sub_cost = raw_response["total_cost_usd"]
            if raw_response.get("model"):
                sub_model = raw_response["model"]

        sub_session_id = uuid4().hex
        sub_name = agent_prompt[:50] if agent_prompt else "Sub-agent"
        # Subagent context isolation invariant (Phase 3, Layer P): children DO NOT inherit the parent's active_mcps or compaction state. They start with the AgentSession defaults (empty lists). Reasoning: - Security: a parent that activated Gmail shouldn't leak Gmail tools to a subagent doing an unrelated task. The user only approved Gmail for the parent. - Token cost: subagents typically have a narrow task, they don't need the parent's full activated set. - Failure isolation: if the parent compacted history, the subagent shouldn't inherit a summary it can't re-expand. If a subagent ever needs a parent activation, the user must approve it explicitly via MCPActivate inside the subagent session, same gate as a fresh top-level chat.
        sub_session = AgentSession(
            id=sub_session_id,
            name=sub_name,
            status="completed",
            model=sub_model,
            mode="sub-agent",
            cwd=session.cwd,
            created_at=datetime.now(),
            cost_usd=sub_cost,
            tokens=sub_tokens,
            messages=[
                Message(role="user", content=agent_prompt, branch_id="main"),
                Message(role="assistant", content=sub_text, branch_id="main"),
            ],
            dashboard_id=session.dashboard_id,
            parent_session_id=session_id,
            # Explicit empty list (matches the model default) so the invariant is visible at the spawn site rather than relying on the field's default_factory.
            active_mcps=[],
        )
        apply_context_window(sub_session)
        ctx.sessions[sub_session_id] = sub_session
        await ws_manager.broadcast_global("agent:status", {
            "session_id": sub_session_id,
            "status": sub_session.status,
            "session": sub_session.model_dump(mode="json"),
        })
        result_payload["sub_session_id"] = sub_session_id

    result_msg = Message(role="tool_result", content=result_payload, branch_id=session.active_branch_id)
    # Spill oversized tool results to per-session disk storage. The replacement keeps the first 4KB inline so the model retains some signal; the rest lives on disk for the UI to surface in the compaction drawer. Crucially this happens at *write* time (before the next turn ships history to the SDK) so the bloat never re-enters context.
    try:
        truncated_content, blob_path = truncate_large_tool_result(
            result_msg.content, session.id, result_msg.id
        )
        if blob_path:
            result_msg.content = truncated_content
            logger.info(f"Spilled tool result {result_msg.id} ({len(blob_path)} chars) to {blob_path}")
    except Exception:
        logger.exception("Tool result truncation failed; keeping inline body")
    session.messages.append(result_msg)
    await ws_manager.send_to_session(session_id, "agent:message", {
        "session_id": session_id,
        "message": result_msg.model_dump(mode="json"),
    })
    return {"continue_": True}
