"""Complex agent-manager operations extracted for the 250-line limit.

Each function is a standalone async operation that receives the sessions
dict (and other dependencies) explicitly.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from uuid import uuid4

from backend.apps.agents.models import (
    AgentSession, Message, MessageBranch,
)
from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.agents.manager.session_store import (
    save_session, load_session_data, delete_session_file,
    build_search_text, copy_session_messages,
)
from backend.apps.analytics.collector import record as _analytics
from backend.apps.agents.execution.agent_loop import run_agent_loop

from backend.apps.agents.execution.agent_loop import run_agent_loop

from backend.apps.agents.execution.agent_mock import fire_session_completed



logger = logging.getLogger(__name__)


async def edit_message_op(
    sessions: dict, tasks: dict,
    session_id: str, message_id: str, new_content: str,
):
    session = sessions.get(session_id)
    if not session:
        raise ValueError(f"Session {session_id} not found")
    existing = tasks.get(session_id)
    if existing and not existing.done():
        existing.cancel()
        try:
            await existing
        except asyncio.CancelledError:
            pass

    target_msg = next((m for m in session.messages if m.id == message_id), None)
    if not target_msg or target_msg.role != "user":
        raise ValueError("Can only edit user messages")

    fork_point_id = message_id
    fork_parent_branch = target_msg.branch_id
    msg_branch = session.branches.get(target_msg.branch_id)
    if msg_branch and msg_branch.fork_point_message_id:
        branch_user_msgs = [m for m in session.messages if m.branch_id == target_msg.branch_id and m.role == "user"]
        if branch_user_msgs and branch_user_msgs[0].id == message_id:
            fork_point_id = msg_branch.fork_point_message_id
            fork_parent_branch = msg_branch.parent_branch_id or "main"

    new_branch_id = uuid4().hex
    new_branch = MessageBranch(id=new_branch_id, parent_branch_id=fork_parent_branch, fork_point_message_id=fork_point_id)
    session.branches[new_branch_id] = new_branch
    session.active_branch_id = new_branch_id
    _analytics("feature.used", {
        "feature": "message.branched",
        "branch_depth": len([b for b in session.branches.values() if b.parent_branch_id]),
        "total_branches_in_session": len(session.branches),
        "messages_before_fork": len([m for m in session.messages if m.branch_id == fork_parent_branch]),
    }, session_id=session_id, dashboard_id=session.dashboard_id)

    edited_msg = Message(
        role="user", content=new_content, branch_id=new_branch_id,
        parent_id=target_msg.parent_id, images=target_msg.images,
        context_paths=target_msg.context_paths, forced_tools=target_msg.forced_tools,
        attached_skills=target_msg.attached_skills,
    )
    session.messages.append(edited_msg)
    await ws_manager.emit_message(session_id, edited_msg)
    await ws_manager.emit_branch_created(session_id, new_branch, new_branch_id)
    session.sdk_session_id = None
    session.status = "running"
    await ws_manager.emit_status(session_id, "running", session)
    task = asyncio.create_task(run_agent_loop(
        sessions, session_id, new_content,
        images=target_msg.images, context_paths=target_msg.context_paths,
        forced_tools=target_msg.forced_tools, attached_skills=target_msg.attached_skills,
    ))
    tasks[session_id] = task


async def close_session_op(
    sessions: dict, tasks: dict,
    session_id: str,
):
    children = [s for s in sessions.values() if s.parent_session_id == session_id and s.mode == "browser-agent"]
    from backend.apps.agents.manager.agent_manager import agent_manager
    # NOTE: this is a circular dependency, must be fixed soon by fixing the ai slop
    for child in children:
        await agent_manager.stop_agent(child.id)
    task = tasks.get(session_id)
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    session = sessions.get(session_id)
    if not session:
        raise ValueError(f"Session {session_id} not found")
    if session.status in ("running", "waiting_approval"):
        session.status = "stopped"
    session.closed_at = datetime.now()
    for req in list(session.pending_approvals):
        ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Session closed"})
    session.pending_approvals = []
    if hasattr(session, '_cancel_event'):
        session._cancel_event.set()
    fire_session_completed(session, sessions)
    doc_data = session.model_dump(mode="json")
    doc_data["search_text"] = build_search_text(session)
    save_session(session_id, doc_data)
    await ws_manager.emit_closed(session_id, session)
    sessions.pop(session_id, None)
    tasks.pop(session_id, None)
    logger.info(f"Session {session_id} closed and persisted")


async def resume_session_op(sessions: dict, session_id: str) -> AgentSession:
    if session_id in sessions:
        return sessions[session_id]
    data = load_session_data(session_id)
    if data is None:
        raise ValueError(f"Session {session_id} not found in history")
    session = AgentSession(**data)
    hours_since = 0
    if data.get("closed_at"):
        try:
            closed = datetime.fromisoformat(data["closed_at"][:19])
            hours_since = round((datetime.now() - closed).total_seconds() / 3600, 1)
        except Exception:
            pass
    _analytics("session.resumed", {
        "hours_since_closed": hours_since,
        "original_message_count": len(data.get("messages", [])),
        "original_cost_usd": data.get("cost_usd", 0), "model": session.model,
    }, session_id=session_id, dashboard_id=session.dashboard_id)
    session.closed_at = None
    sessions[session_id] = session
    delete_session_file(session_id)
    await ws_manager.emit_status(session_id, session.status, session)
    logger.info(f"Session {session_id} resumed from history")
    return session


async def duplicate_session_op(
    sessions: dict, session_id: str,
    dashboard_id: str | None = None, up_to_message_id: str | None = None,
) -> AgentSession:
    source = sessions.get(session_id)
    if not source:
        data = load_session_data(session_id)
        if data is None:
            raise ValueError(f"Session {session_id} not found")
        source = AgentSession(**data)
    new_messages, new_branches, _ = copy_session_messages(source, up_to_message_id)
    new_session = AgentSession(
        id=uuid4().hex, name=f"{source.name} (copy)", status="stopped",
        model=source.model, mode=source.mode, system_prompt=source.system_prompt,
        allowed_tools=list(source.allowed_tools), max_turns=source.max_turns,
        cwd=source.cwd, created_at=datetime.now(), messages=new_messages,
        branches=new_branches, active_branch_id=source.active_branch_id,
        tool_group_meta=dict(source.tool_group_meta),
        dashboard_id=dashboard_id or source.dashboard_id,
    )
    sessions[new_session.id] = new_session
    await ws_manager.emit_status(new_session.id, new_session.status, new_session)
    return new_session


async def invoke_agent_op(
    sessions: dict, source_session_id: str, message: str,
    parent_session_id: str | None = None, dashboard_id: str | None = None,
) -> dict:
    source = sessions.get(source_session_id)
    if not source:
        data = load_session_data(source_session_id)
        if data is None:
            raise ValueError(f"Session {source_session_id} not found")
        source = AgentSession(**data)
    source_name = source.name
    new_messages, new_branches, _ = copy_session_messages(source)
    fork = AgentSession(
        id=uuid4().hex, name=f"{source_name} (invoked)", status="running",
        model=source.model, mode="invoked-agent", sdk_session_id=source.sdk_session_id,
        system_prompt=source.system_prompt, allowed_tools=list(source.allowed_tools),
        max_turns=source.max_turns or 25, cwd=source.cwd, created_at=datetime.now(),
        messages=new_messages, branches=new_branches,
        active_branch_id=source.active_branch_id,
        tool_group_meta=dict(source.tool_group_meta),
        dashboard_id=dashboard_id or source.dashboard_id,
        parent_session_id=parent_session_id,
    )
    sessions[fork.id] = fork
    await ws_manager.broadcast_global("agent:status", {
        "session_id": fork.id, "status": fork.status,
        "session": fork.model_dump(mode="json"),
    })
    user_msg = Message(role="user", content=message, branch_id=fork.active_branch_id)
    fork.messages.append(user_msg)
    await ws_manager.emit_message(fork.id, user_msg)
    await run_agent_loop(sessions, fork.id, message, fork_session=True)
    last_assistant = None
    for msg in reversed(fork.messages):
        if msg.role == "assistant":
            content = msg.content
            if isinstance(content, str):
                last_assistant = content
            elif isinstance(content, list):
                texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                last_assistant = "\n".join(texts)
            else:
                last_assistant = str(content)
            break
    return {
        "forked_session_id": fork.id, "source_name": source_name,
        "response": last_assistant or "No response from invoked agent.",
        "cost_usd": fork.cost_usd,
    }