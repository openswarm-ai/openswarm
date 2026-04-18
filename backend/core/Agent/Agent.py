import asyncio
import os
import traceback
from copy import deepcopy
from typing import Any, Dict, List, Literal, Optional
from uuid import uuid4

from claude_agent_sdk import ClaudeAgentOptions
from pydantic import BaseModel, Field, InstanceOf
from typeguard import typechecked

from backend.core.Agent.run_agent_loop.run_agent_loop import run_agent_loop
from backend.core.shared_structs.agent.Message.Message import UserMessage
from backend.core.shared_structs.agent.ApprovalRequest import ApprovalRequest
from backend.core.shared_structs.agent.MessageLog import MessageLog
from backend.core.events.events import (
    AgentSnapshot, AgentStatusEvent, AgentMessageEvent,
    ApprovalRequestEvent, EventCallback, AnyEvent,
)
from backend.core.tools.shared_structs.Toolkit import Toolkit
from swarm_debug import debug

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

    toolkit: Optional[Toolkit] = Field(default=None, exclude=True)
    on_event: Optional[EventCallback] = Field(default=None, exclude=True)

    task: Optional[InstanceOf[asyncio.Task]] = None
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
    async def _handle_event(self, event: AnyEvent) -> None:
        """Internal event handler that updates Agent state and forwards to on_event."""
        if isinstance(event, AgentStatusEvent):
            self.status = event.status  # type: ignore[assignment]
        if self.on_event:
            await self.on_event(event)

    @typechecked
    async def request_approval(
        self, tool_name: str, tool_input: Dict[str, Any],
    ) -> Dict[str, Any]:
        """HITL approval flow: pause the agent, ask the user, resume.

        Emits an ApprovalRequestEvent through on_event. The transport layer
        resolves the embedded future with the user's decision.
        Returns {"behavior": "allow"|"deny", ...}.
        """
        if not self.on_event:
            return {"behavior": "allow"}

        request: ApprovalRequest = ApprovalRequest(
            session_id=self.session_id,
            tool_name=tool_name,
            tool_input=tool_input,
        )
        self.pending_approvals.append(request)
        self.status = "waiting_approval"
        await self.emit(AgentStatusEvent(
            session_id=self.session_id, status="waiting_approval",
        ))

        future: asyncio.Future = asyncio.get_event_loop().create_future()
        try:
            await self.emit(ApprovalRequestEvent(
                session_id=self.session_id,
                request_id=request.id,
                tool_name=tool_name,
                tool_input=tool_input,
                future=future,
            ))
            decision: Dict[str, Any] = await future
        except asyncio.TimeoutError:
            decision = {"behavior": "deny", "message": "Approval timed out"}
        except asyncio.CancelledError:
            decision = {"behavior": "deny", "message": "Agent stopped"}
            raise

        self.pending_approvals = [
            a for a in self.pending_approvals if a.id != request.id
        ]
        self.status = "running"
        await self.emit(AgentStatusEvent(
            session_id=self.session_id, status="running",
        ))
        return decision

    @typechecked
    async def send_message(self, msg: UserMessage) -> None:
        async with self.lock:
            if self.task is not None and not self.task.done():
                debug(f"[Agent.send_message] Agent {self.session_id} is already running")
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
                prompt_msg=msg.to_prompt(),
                messages=self.messages,
                options=self.config,
                session_id=self.session_id,
                branch_id=self.branch_id,
                emit=self._handle_event,
            ))
            self.task.add_done_callback(self.p_on_task_done)

    @typechecked
    def p_on_task_done(self, task: asyncio.Task) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
            debug(f"[Agent] Task for {self.session_id} failed:\n{tb}")

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
            "toolkit": self.toolkit,
            "on_event": self.on_event,
            "task": None,
            "lock": asyncio.Lock(),
        })
        self.sub_branches.append(child)
        return child