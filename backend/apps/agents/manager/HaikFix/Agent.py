# TODO: NON HAIK DEPS: ws_manager

from uuid import uuid4
import asyncio
import os

from claude_agent_sdk import ClaudeAgentOptions
from pydantic import BaseModel, Field, InstanceOf
from typing import List, Literal, Optional
from typeguard import typechecked

from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.agents.manager.HaikFix.run_agent_loop.run_agent_loop import run_agent_loop
from backend.apps.agents.manager.HaikFix.shared_structs.Message import Message
from backend.apps.agents.manager.HaikFix.shared_structs.PromptChunks import ImageChunk
from backend.apps.agents.manager.HaikFix.shared_structs.ApprovalRequest import ApprovalRequest

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
    status: Literal["running", "waiting_approval", "completed", "error", "stopped"]
    pending_approvals: List[ApprovalRequest] = Field(default_factory=list)

    session_id: str = Field(default_factory=lambda: uuid4().hex)
    config: ClaudeAgentOptions

    branch_id: str = "main"
    children: List["Agent"] = Field(default_factory=list)
    parent_id: Optional[str] = None

    task: Optional[asyncio.Task] = None
    lock: InstanceOf[asyncio.Lock] = Field(default_factory=asyncio.Lock)

    @typechecked
    async def send_message(
        self, 
        prompt: str,
        images: Optional[List[ImageChunk]] = None,
    ) -> None:
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

    @typechecked
    async def stop_agent(self):
        for child in self.children:
            await child.stop_agent()

        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

        # if self.session:
        for req in list[ApprovalRequest](self.pending_approvals):
            ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Agent stopped"})
        self.pending_approvals = []
       
        self.status = "stopped"
        await ws_manager.emit_status(self.session.id, "stopped", self.session)