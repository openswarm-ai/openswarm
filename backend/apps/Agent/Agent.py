from copy import deepcopy
from uuid import uuid4
import asyncio
import os

from claude_agent_sdk import ClaudeAgentOptions
from pydantic import BaseModel, Field, InstanceOf
from typing import Awaitable, Callable, List, Literal, Optional
from typeguard import typechecked

from backend.apps.HaikFix.Agent.run_agent_loop.run_agent_loop import run_agent_loop
from backend.apps.HaikFix.Agent.shared_structs.Message.Message import Message
from backend.apps.HaikFix.Agent.shared_structs.ApprovalRequest import ApprovalRequest
from backend.apps.HaikFix.Agent.shared_structs.MessageLog import MessageLog
from backend.apps.HaikFix.Agent.shared_structs.events import (
    AnyEvent, AgentSnapshot, AgentStatusEvent, AgentMessageEvent,
    EventCallback,
)

os.environ.setdefault("CLAUDE_CODE_STREAM_CLOSE_TIMEOUT", "3600000")

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

    on_event: Optional[EventCallback] = Field(default=None, exclude=True)

    task: Optional[asyncio.Task] = None
    lock: InstanceOf[asyncio.Lock] = Field(default_factory=asyncio.Lock)

    @typechecked
    def snapshot(self) -> AgentSnapshot:
        return AgentSnapshot(
            session_id=self.session_id,
            model=self.model,
            mode=self.mode,
            status=self.status,
            branch_id=self.branch_id,
            parent_id=self.parent_id,
            messages=self.messages,
            pending_approvals=self.pending_approvals,
        )

    @typechecked
    async def emit(self, event: AnyEvent) -> None:
        if self.on_event:
            await self.on_event(event)

    @typechecked
    async def send_message(self, msg: Message) -> None:
        async with self.lock:
            if self.task is not None and not self.task.done():
                print("[Agent.send_message] Agent is already running")
                return

            await self.emit(AgentMessageEvent(
                session_id=self.session_id,
                message=msg,
            ))
            self.status = "running"
            await self.emit(AgentStatusEvent(
                session_id=self.session_id, status="running",
            ))
            self.messages.append(msg)

            self.task = asyncio.create_task(run_agent_loop(
                msg=msg,
                options=self.config,
                branch_id=self.branch_id,
                emit=self.on_event,
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

        self.pending_approvals = []
        self.status = "stopped"
        await self.emit(AgentStatusEvent(
            session_id=self.session_id, status="stopped",
        ))

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
            "on_event": self.on_event,
            "task": None,
            "lock": asyncio.Lock(),
        })
        self.sub_branches.append(child)
        return child