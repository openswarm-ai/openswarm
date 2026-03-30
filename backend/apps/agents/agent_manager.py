"""Thin coordinator for agent sessions.

Heavy logic lives in sibling modules:
- agent_manager_ops – edit, close, resume, duplicate, invoke, LLM metadata
- agent_loop        – the SDK query loop, streaming, mock agent
- agent_mock        – session-completed analytics
- prompt_builder    – system-prompt composition & context injection
- mcp_builder       – MCP server construction & tool-policy helpers
- session_store     – on-disk persistence, history, message copying
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime
from typing import Optional
from uuid import uuid4

from backend.apps.agents.models import AgentConfig, AgentSession, Message
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.agents.prompt_builder import resolve_mode
from backend.apps.agents.mcp_builder import get_all_tool_names
from backend.apps.agents.session_store import (
    delete_session_file, get_history,
    reconcile_on_startup, get_browser_agent_children,
)
from backend.apps.agents.agent_loop import run_agent_loop
from backend.apps.agents.agent_manager_ops import (
    edit_message_op, close_session_op, resume_session_op,
    duplicate_session_op, invoke_agent_op,
)
from backend.apps.agents.agent_manager_meta import (
    generate_title_op, generate_group_meta_op,
    persist_all_sessions_op, restore_all_sessions_op,
)
from backend.apps.settings.settings import load_settings
from backend.apps.analytics.collector import record as _analytics

logger = logging.getLogger(__name__)

os.environ.setdefault("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", "3600000")


class AgentManager:
    def __init__(self):
        self.sessions: dict[str, AgentSession] = {}
        self.tasks: dict[str, asyncio.Task] = {}

    async def launch_agent(self, config: AgentConfig) -> AgentSession:
        session_id = uuid4().hex
        mode_tools, _, mode_folder = resolve_mode(config.mode, get_all_tool_names)
        global_settings = load_settings()
        effective_cwd = (
            config.target_directory or mode_folder
            or global_settings.default_folder or os.path.expanduser("~")
        )
        if config.mode in ("view-builder", "skill-builder") and not config.target_directory:
            effective_cwd = os.path.join(effective_cwd, session_id)
        os.makedirs(effective_cwd, exist_ok=True)
        session = AgentSession(
            id=session_id, name=config.name,
            provider=getattr(config, "provider", "anthropic"),
            model=config.model, mode=config.mode,
            system_prompt=config.system_prompt, allowed_tools=mode_tools,
            max_turns=config.max_turns, cwd=effective_cwd,
            dashboard_id=config.dashboard_id,
        )
        self.sessions[session_id] = session
        _analytics("session.started", {
            "model": session.model, "provider": session.provider,
            "mode": session.mode, "tool_count": len(mode_tools),
        }, session_id=session_id, dashboard_id=config.dashboard_id)
        await ws_manager.emit_status(session_id, "running", session)
        return session

    async def send_message(
        self, session_id: str, prompt: str,
        mode: str | None = None, model: str | None = None,
        provider: str | None = None, images: list | None = None,
        context_paths: list | None = None, forced_tools: list[str] | None = None,
        attached_skills: list | None = None, hidden: bool = False,
        selected_browser_ids: list[str] | None = None,
    ):
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        existing = self.tasks.get(session_id)
        if existing and not existing.done():
            return

        session_changed = False
        if model and model != session.model:
            _analytics("model.switched", {
                "from_model": session.model, "to_model": model,
                "from_provider": session.provider, "to_provider": provider or session.provider,
                "message_number": len([m for m in session.messages if m.role == "user"]),
                "cost_so_far": session.cost_usd,
            }, session_id=session_id, dashboard_id=session.dashboard_id)
            session.model = model
            session_changed = True
        if mode and mode != session.mode:
            _analytics("feature.used", {"feature": "mode.switched", "from_mode": session.mode, "to_mode": mode}, session_id=session_id, dashboard_id=session.dashboard_id)
            session.mode = mode
            mode_tools, _, _ = resolve_mode(mode, get_all_tool_names)
            session.allowed_tools = mode_tools
            session_changed = True
        if session_changed:
            await ws_manager.emit_status(session_id, session.status, session)

        skill_meta = [{"id": s["id"], "name": s["name"]} for s in (attached_skills or [])] or None
        image_meta = [{"data": img["data"], "media_type": img.get("media_type", "image/png")} for img in (images or [])] or None
        user_msg = Message(
            role="user", content=prompt, branch_id=session.active_branch_id,
            context_paths=context_paths or None, attached_skills=skill_meta,
            forced_tools=forced_tools or None, images=image_meta, hidden=hidden,
        )
        session.messages.append(user_msg)
        await ws_manager.emit_message(session_id, user_msg)
        if context_paths or attached_skills or images or forced_tools:
            _analytics("context.attached", {
                "file_count": len([c for c in (context_paths or []) if c.get("type") == "file"]),
                "directory_count": len([c for c in (context_paths or []) if c.get("type") == "directory"]),
                "skill_count": len(attached_skills or []), "image_count": len(images or []),
                "has_forced_tools": bool(forced_tools),
            }, session_id=session_id, dashboard_id=session.dashboard_id)
        for skill in (attached_skills or []):
            _analytics("feature.used", {"feature": "skill.used", "skill_name": skill.get("name", "")}, session_id=session_id, dashboard_id=session.dashboard_id)
        is_first = sum(1 for m in session.messages if m.role == "user") == 1
        if is_first:
            _analytics("session.first_message", {
                "message_length": len(prompt), "has_code_block": "```" in prompt,
                "has_url": "http://" in prompt or "https://" in prompt,
                "model": session.model, "mode": session.mode,
            }, session_id=session_id, dashboard_id=session.dashboard_id)

        session.status = "running"
        await ws_manager.emit_status(session_id, "running", session)
        task = asyncio.create_task(run_agent_loop(
            self.sessions, session_id, prompt, images=images,
            context_paths=context_paths, forced_tools=forced_tools,
            attached_skills=attached_skills, selected_browser_ids=selected_browser_ids,
        ))
        self.tasks[session_id] = task

    async def stop_agent(self, session_id: str):
        task = self.tasks.get(session_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        session = self.sessions.get(session_id)
        if session:
            for req in list(session.pending_approvals):
                ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Agent stopped"})
            session.pending_approvals = []
            if hasattr(session, '_cancel_event'):
                session._cancel_event.set()
            session.status = "stopped"
            if not session.closed_at:
                session.closed_at = datetime.now()
            await ws_manager.emit_status(session_id, "stopped", session)
        children = [s for s in self.sessions.values() if s.parent_session_id == session_id and s.mode == "browser-agent"]
        for child in children:
            await self.stop_agent(child.id)

    def handle_approval(self, request_id: str, decision: dict):
        ws_manager.resolve_approval(request_id, decision)

    async def edit_message(self, session_id: str, message_id: str, new_content: str):
        await edit_message_op(self.sessions, self.tasks, session_id, message_id, new_content)

    async def switch_branch(self, session_id: str, branch_id: str):
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        if branch_id not in session.branches:
            raise ValueError(f"Branch {branch_id} not found")
        session.active_branch_id = branch_id
        await ws_manager.emit_branch_switched(session_id, branch_id)

    async def generate_title(self, session_id: str, first_prompt: str) -> str:
        return await generate_title_op(self.sessions, session_id, first_prompt)

    async def generate_group_meta(self, session_id: str, group_id: str, tool_calls: list[dict], results_summary: list[str] | None = None, is_refinement: bool = False) -> dict:
        return await generate_group_meta_op(self.sessions, session_id, group_id, tool_calls, results_summary, is_refinement)

    async def update_session(self, session_id: str, **fields):
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")
        for key, value in fields.items():
            if key in {"system_prompt", "name"}:
                setattr(session, key, value)
        await ws_manager.emit_status(session_id, session.status, session)

    async def close_session(self, session_id: str) -> None:
        await close_session_op(self.sessions, self.tasks, session_id)

    async def delete_session(self, session_id: str) -> None:
        from backend.apps.agents.agent_manager_ops import delete_session_op
        await delete_session_op(self, session_id)

    async def resume_session(self, session_id: str) -> AgentSession:
        return await resume_session_op(self.sessions, session_id)

    async def duplicate_session(self, session_id: str, dashboard_id: str | None = None, up_to_message_id: str | None = None) -> AgentSession:
        return await duplicate_session_op(self.sessions, session_id, dashboard_id, up_to_message_id)

    async def invoke_agent(self, source_session_id: str, message: str, parent_session_id: str | None = None, dashboard_id: str | None = None) -> dict:
        return await invoke_agent_op(self.sessions, source_session_id, message, parent_session_id, dashboard_id)

    def get_all_sessions(self, dashboard_id: str | None = None) -> list[AgentSession]:
        if dashboard_id:
            return [s for s in self.sessions.values() if s.dashboard_id == dashboard_id]
        return list(self.sessions.values())

    def get_session(self, session_id: str) -> Optional[AgentSession]:
        return self.sessions.get(session_id)

    def get_history(self, q: str = "", limit: int = 20, offset: int = 0, dashboard_id: str | None = None) -> dict:
        return get_history(q=q, limit=limit, offset=offset, dashboard_id=dashboard_id)

    async def reconcile_on_startup(self) -> None:
        return await reconcile_on_startup()

    async def persist_all_sessions(self) -> None:
        await persist_all_sessions_op(self.sessions, self.tasks)

    async def restore_all_sessions(self) -> None:
        await restore_all_sessions_op(self.sessions)

    def get_browser_agent_children(self, parent_session_id: str) -> list[dict]:
        return get_browser_agent_children(self.sessions, parent_session_id)


agent_manager = AgentManager()
