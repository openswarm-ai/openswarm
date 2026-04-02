# TODO: NON HAIK DEPS: ws_manager

from copy import deepcopy
from uuid import uuid4
import asyncio
import os

from claude_agent_sdk import ClaudeAgentOptions
from pydantic import BaseModel, Field, InstanceOf
from typing import List, Literal, Optional
from typeguard import typechecked

from backend.apps.agents.manager.ws_manager import ws_manager
from backend.apps.HaikFix.Agent.run_agent_loop.run_agent_loop import run_agent_loop
from backend.apps.HaikFix.Agent.shared_structs.Message.Message import Message
from backend.apps.HaikFix.Agent.shared_structs.ApprovalRequest import ApprovalRequest
from backend.apps.HaikFix.Agent.shared_structs.MessageLog import MessageLog

os.environ.setdefault("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", "3600000")


# NOTE and TODO: we shld remove the ws streaming from this class bc it conflicts with the browser agent

class Agent(BaseModel):
    model: str
    mode: str
    status: Literal["running", "waiting_approval", "completed", "error", "stopped"]
    pending_approvals: List[ApprovalRequest] = Field(default_factory=list)

    messages: MessageLog = Field(default_factory=MessageLog)

    session_id: str = Field(default_factory=lambda: uuid4().hex)
    config: ClaudeAgentOptions

    branch_id: str = "main"
    sub_agents: List["Agent"] = Field(default_factory=list)
    sub_branches: List["Agent"] = Field(default_factory=list)
    parent_id: Optional[str] = None

    task: Optional[asyncio.Task] = None
    lock: InstanceOf[asyncio.Lock] = Field(default_factory=asyncio.Lock)

    @typechecked
    async def send_message(self, msg: Message) -> None:
        async with self.lock:
            if self.task is not None and not self.task.done():
                print("[Agent.send_message] Agent is already running")
                return

            await ws_manager.emit_message(self.session_id, msg)
            self.status = "running"
            await ws_manager.emit_status(self.session_id, "running")
            self.messages.append(msg)

            self.task = asyncio.create_task(run_agent_loop(
                msg=msg,
                options=self.config,
                branch_id=self.branch_id,
            ))

    @typechecked
    async def stop_agent(self):
        for child in self.sub_agents:
            await child.stop_agent()

        if self.task and not self.task.done():
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass

        for req in list[ApprovalRequest](self.pending_approvals):
            ws_manager.resolve_approval(req.id, {"behavior": "deny", "message": "Agent stopped"})
        self.pending_approvals = []
       
        self.status = "stopped"
        await ws_manager.emit_status(self.session_id, "stopped")
    
    @typechecked
    def branch(self, at_message_id: str) -> "Agent":
        branch_id = uuid4().hex
        branched_messages = deepcopy(self.messages.slice_to(at_message_id))
        child = self.model_copy(deep=True, update={
            "session_id": uuid4().hex,
            "branch_id": branch_id,
            "parent_id": self.session_id,
            "status": "completed",
            "messages": MessageLog(messages=branched_messages),
            "sub_agents": [],
            "pending_approvals": [],
            "task": None,
            "lock": asyncio.Lock(),
        })
        self.sub_branches.append(child)
        return child