"""The SDK PostToolUse hook, lifted out of the agent loop. Runs after every tool call:
records per-tool latency, normalizes the raw tool response into displayable text, re-renders
view-builder writes (and drains build errors), spills oversized results to disk, and
broadcasts the tool_result message.
Operates on the HookContext (its `sessions` is the manager's live registry). The dict returns
and payloads are the SDK hook protocol / existing message shapes, not internal models."""

import asyncio
import logging
import time
from typing import Dict

from typeguard import typechecked

from backend.apps.agents.core.models import Message
from backend.apps.agents.core.ws_manager import ws_manager
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

    if wrote_frontend_file or installed_pkg:
        try:
            from backend.apps.outputs.runtime import (
                manager as outputs_runtime_manager,
            )
            # ANY session building an app has a preview runtime attached: the dedicated view-builder AND
            # a plain agent using CreateApp (how onboarding builds its dashboard). Gate on the runtime,
            # not the mode, so the Stop render-gate covers agent-mode app builds too (a plain /frontend/
            # write with no runtime, e.g. editing OpenSwarm's own source, has none and is skipped).
            if outputs_runtime_manager.get(session.id) is not None:
                view_builder_dirty_sessions.add(session.id)
                outputs_runtime_manager.reset_render_state_for_workspace(session.id)
                if installed_pkg:
                    # Tell the app card this turn changed deps so its turn-finish reload restarts Vite; a soft webview reload can't pick up newly installed packages.
                    try:
                        await ws_manager.send_to_session(session.id, "agent:app_deps_changed", {
                            "session_id": session.id,
                        })
                    except Exception:
                        pass
        except Exception:
            pass
    # Every write drains, App Builder included. This was an `elif` on the branch above, so a view-builder frontend write took that branch and skipped the drain: the one agent whose whole job is the app never saw its own vite/babel/tsc errors.
    if wrote_files and file_path:
        errs: list[str] = []
        console_errs: list[str] = []
        try:
            # Give vite/uvicorn a beat to actually emit whatever this write broke.
            await asyncio.sleep(0.4)
            from backend.apps.outputs.runtime import (
                manager as outputs_runtime_manager,
            )
            errs = outputs_runtime_manager.drain_errors_for_path(file_path)
            console_errs = outputs_runtime_manager.drain_frontend_errors_for_path(file_path)
        except Exception:
            pass
        notes = []
        if errs:
            notes.append("Build server reported (after this write):\n" + "\n".join(errs[-20:]))
        if console_errs:
            notes.append("The app's console logged (after this write):\n" + "\n".join(console_errs[-10:]))
        if notes:
            content = f"{content}\n\n" + wrap_platform_note("\n\n".join(notes))

    result_payload = {"text": content}
    hook_tool_name = input_data.get("tool_name", "")
    if hook_tool_name:
        result_payload["tool_name"] = hook_tool_name
    if elapsed_ms is not None:
        result_payload["elapsed_ms"] = elapsed_ms

    # The CLI's built-in Agent/Task sub-agent tool is hard-blocked (disallowed_tools) and replaced by the SpawnAgent MCP route, which materializes real child sessions itself; no per-tool branch needed here anymore.
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
