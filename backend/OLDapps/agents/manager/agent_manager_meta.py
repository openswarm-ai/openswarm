"""LLM-powered metadata, persistence helpers, and delete operation.

Extracted from agent_manager_ops to keep every file under 250 lines.
"""

from __future__ import annotations

import asyncio
import logging

from backend.apps.agents.models import AgentSession, ToolGroupMeta
from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.agents.manager.session_store import (
    save_session, delete_session_file, build_search_text,
)
from backend.apps.common.llm_helpers import quick_llm_call, quick_llm_json
from backend.apps.agents.manager.session_store import load_all_session_data
from backend.apps.agents.execution.agent_mock import fire_session_completed


logger = logging.getLogger(__name__)


async def generate_title_op(sessions: dict, session_id: str, first_prompt: str) -> str:
    session = sessions.get(session_id)
    if not session:
        raise ValueError(f"Session {session_id} not found")
    title = first_prompt[:40].strip()
    try:
        title = await quick_llm_call(
            "Generate a concise 3-6 word title for a chat that starts with this message. Return only the title, nothing else.",
            first_prompt, max_tokens=30,
        )
        title = title.strip('"\'') or first_prompt[:40].strip()
    except Exception as e:
        logger.warning(f"Title generation failed, using fallback: {e}")
    session.name = title
    await ws_manager.emit_name_updated(session_id, title)
    return title


async def generate_group_meta_op(
    sessions: dict, session_id: str, group_id: str,
    tool_calls: list[dict], results_summary: list[str] | None = None,
    is_refinement: bool = False,
) -> dict:
    session = sessions.get(session_id)
    if not session:
        raise ValueError(f"Session {session_id} not found")
    fallback_name = tool_calls[0].get("tool", "Tool calls") if tool_calls else "Tool calls"
    fallback_name = fallback_name.split("__")[-1].replace("_", " ").title() if "__" in fallback_name else fallback_name
    name, svg = fallback_name, ""
    try:
        tool_desc = "\n".join(f"- {tc.get('tool', '?')}: {tc.get('input_summary', '')}" for tc in tool_calls)
        user_content = f"Tool actions:\n{tool_desc}"
        if results_summary:
            user_content += "\n\nResults:\n" + "\n".join(f"- {r}" for r in results_summary)
        system = (
            "Generate a concise 2-5 word name and a minimal SVG icon for a group of tool actions.\n\n"
            "Return ONLY valid JSON: {\"name\": \"...\", \"svg\": \"...\"}\n\n"
            "Name rules:\n- 2-5 words, title case, describes the action\n\n"
            "SVG rules:\n- 24x24 viewBox\n- Use currentColor for all stroke/fill\n"
            "- Simple geometric shapes only\n- No text, no images, no gradients\n"
            "- Max 400 characters for the svg string"
        )
        parsed = await quick_llm_json(system, user_content)
        if parsed.get("name"):
            name = parsed["name"].strip().strip("\"'")
        if parsed.get("svg"):
            svg = parsed["svg"].strip()
    except Exception as e:
        logger.warning(f"Group meta generation failed, using fallback: {e}")

    meta = ToolGroupMeta(id=group_id, name=name, svg=svg, is_refined=is_refinement)
    session.tool_group_meta[group_id] = meta
    await ws_manager.emit_group_meta_updated(session_id, group_id, name, svg, is_refinement)
    return {"name": name, "svg": svg, "is_refined": is_refinement}


async def persist_all_sessions_op(sessions: dict, tasks: dict) -> None:
    for session_id, session in list(sessions.items()):
        if session.status in ("running", "waiting_approval"):
            session.status = "stopped"
        for req in list(session.pending_approvals):
            ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Server shutting down"})
        session.pending_approvals = []
        fire_session_completed(session, sessions)
        doc_data = session.model_dump(mode="json")
        doc_data["search_text"] = build_search_text(session)
        save_session(session_id, doc_data)
        logger.info(f"Persisted session {session_id} on shutdown")
    sessions.clear()
    tasks.clear()


async def restore_all_sessions_op(sessions: dict) -> None:
    for sid, data in load_all_session_data():
        try:
            session = AgentSession(**data)
        except Exception as e:
            logger.warning(f"Skipping corrupt session file {sid}: {e}")
            continue
        if session.closed_at is not None:
            continue
        if session.status in ("running", "waiting_approval"):
            session.status = "stopped"
        session.pending_approvals = []
        sessions[session.id] = session
        delete_session_file(sid)
        logger.info(f"Restored session {session.id}")


async def delete_session_op(manager, session_id: str) -> None:
    children = [s for s in manager.sessions.values() if s.parent_session_id == session_id and s.mode == "browser-agent"]
    for child in children:
        await manager.stop_agent(child.id)
    task = manager.tasks.get(session_id)
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    manager.sessions.pop(session_id, None)
    manager.tasks.pop(session_id, None)
    delete_session_file(session_id)
    logger.info(f"Session {session_id} permanently deleted")
