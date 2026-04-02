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

from backend.apps.agents.models import AgentSession, AgentConfig, ApprovalRequest
from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.agents.execution.prompt_builder import resolve_mode
from backend.apps.agents.execution.mcp_builder import get_all_tool_names
from backend.apps.settings.settings import load_settings
from backend.apps.agents.manager.HaikFix.agent_loop import run_agent_loop
from backend.apps.agents.manager.HaikFix.helpers.Message import Message
from backend.apps.agents.manager.HaikFix.PromptChunks import ImageChunk


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
    session: Optional[AgentSession] = None
    branch_id: str = "main"
    parent_id: Optional[str] = None
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
        self.session = AgentSession(
            id=session_id, name=config.name,
            provider=getattr(config, "provider", "anthropic"),
            model=config.model, mode=config.mode,
            system_prompt=config.system_prompt, allowed_tools=mode_tools,
            max_turns=config.max_turns, cwd=effective_cwd,
            dashboard_id=config.dashboard_id,
        )
        self.session_id = session_id
        await ws_manager.emit_status(session_id, "running", self.session)
        return self.session

    async def send_message(
        self, 
        prompt: str,
        images: Optional[List[ImageChunk]] = None,
    ):
        async with self.lock:
            if self.task is not None and not self.task.done():
                print("[Agent.send_message] Agent is already running")
                return
            
            user_msg = Message(
                role="user", 
                content=prompt, 
                branch_id=self.branch_id,
                parent_id=self.parent_id,
                images=images,
            )

            await ws_manager.emit_message(self.session_id, user_msg)
            self.status = "running"
            await ws_manager.emit_status(self.session_id, "running", self)

            self.task = asyncio.create_task(run_agent_loop(
                prompt=prompt,
                images=images,
                options=self.config,
                branch_id=self.branch_id,
                parent_id=self.parent_id,
            ))

    async def stop_agent(self):
        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        if self.session:
            for req in list[ApprovalRequest](self.session.pending_approvals):
                ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Agent stopped"})
            self.session.pending_approvals = []
            if hasattr(self.session, '_cancel_event'):
                self.session._cancel_event.set()
            self.session.status = "stopped"
            if not self.session.closed_at:
                self.session.closed_at = datetime.now()
            await ws_manager.emit_status(self.session.id, "stopped", self.session)
        self.status = "stopped"
