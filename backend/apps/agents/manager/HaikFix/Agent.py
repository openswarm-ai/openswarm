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
from uuid import uuid4

from claude_agent_sdk import ClaudeAgentOptions
from pydantic import BaseModel, InstanceOf
from typing import List, Literal, Optional
from typeguard import typechecked

from backend.apps.agents.models import AgentSession, Message
from backend.apps.agents.manager.AgentConfig import AgentConfig
from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.agents.execution.prompt_builder import resolve_mode
from backend.apps.agents.execution.mcp_builder import get_all_tool_names
from backend.apps.agents.execution.agent_loop import run_agent_loop
from backend.apps.settings.settings import load_settings


logger = logging.getLogger(__name__)

os.environ.setdefault("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", "3600000")

class ContextPath(BaseModel):
    path: str
    type: Literal["file", "directory"]

class Skill(BaseModel):
    name: str
    content: str


class Agent(BaseModel):
    model: str
    mode: str
    session_id: str
    status: Literal["running", "waiting_approval", "completed", "error", "stopped"]
    lock: InstanceOf[asyncio.Lock]
    config: ClaudeAgentOptions
    task: Optional[asyncio.Task] = None

    @typechecked
    def __init__(
        self, 
        model: str,
        mode: str,
        tools: List[str],
        effective_cwd: str,
        config: ClaudeAgentOptions,
    ) -> None:
        id: str = uuid4().hex
        lock: asyncio.Lock = asyncio.Lock()
        super().__init__(
            model=model, 
            mode=mode, 
            tools=tools, 
            effective_cwd=effective_cwd, 
            status="running",
            id=id,
            task=None,
            lock=lock,
            config=config,
        )

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
        await ws_manager.emit_status(session_id, "running", session)
        return session

    async def send_message(
        self, 
        prompt: str,
        images: Optional[list] = None,
    ):
        async with self.lock:
            if self.task is not None and not self.task.done():
                print("[Agent.send_message] Agent is already running")
                return

        skill_meta = [{"id": s["id"], "name": s["name"]} for s in (attached_skills or [])] or None
        image_meta = [{"data": img["data"], "media_type": img.get("media_type", "image/png")} for img in (images or [])] or None
        user_msg = Message(
            role="user", content=prompt, branch_id=session.active_branch_id,
            context_paths=context_paths or None, attached_skills=skill_meta,
            forced_tools=forced_tools or None, images=image_meta, hidden=hidden,
        )
        session.messages.append(user_msg)
        await ws_manager.emit_message(session_id, user_msg)

        session.status = "running"
        await ws_manager.emit_status(session_id, "running", session)
        task = asyncio.create_task(run_agent_loop(
            self.sessions, session_id, prompt, images=images,
            context_paths=context_paths, forced_tools=forced_tools,
            attached_skills=attached_skills, selected_browser_ids=selected_browser_ids,
        ))
        self.tasks[session_id] = task
    
    async def send_message_old(
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
            session.model = model
            session_changed = True
        if mode and mode != session.mode:
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
