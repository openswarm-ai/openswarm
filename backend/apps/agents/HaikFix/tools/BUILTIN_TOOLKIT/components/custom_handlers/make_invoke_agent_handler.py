# make_invoke_agent_handler.py

from typing import Dict, TypedDict
from typeguard import typechecked
from uuid import uuid4
import asyncio

from backend.apps.agents.HaikFix.Agent.shared_structs.Message.agent_outputs import ToolResponse
from backend.apps.agents.HaikFix.Agent.shared_structs.Message.Message import (
    AnyMessage, UserMessage, AssistantMessage,
)
from backend.apps.agents.HaikFix.Agent.Agent import Agent


class InvokeAgentInput(TypedDict):
    session_id: str
    message: str


@typechecked
def make_invoke_agent_handler(agent_registry: Dict[str, Agent]):
    async def handler(args: InvokeAgentInput) -> ToolResponse:
        session_id = args["session_id"]
        message = args["message"]

        source = agent_registry.get(session_id)
        if not source:
            return {"content": [{"type": "text", "text": f"Error: session {session_id} not found"}], "is_error": True}

        if len(source.messages) == 0:
            return {"content": [{"type": "text", "text": "Error: source agent has no messages"}], "is_error": True}

        fork = source.branch(source.messages.messages[-1].id)
        agent_registry[fork.session_id] = fork

        msg = UserMessage(content=message, branch_id=fork.branch_id)
        await fork.send_message(msg)
        if fork.task:
            await fork.task

        last_response = "No response from invoked agent."
        for m in reversed[AnyMessage](fork.messages.messages):
            if isinstance(m, AssistantMessage):
                last_response = m.content
                break

        return {
            "content": [
                {
                    "type": "text", 
                    "text": (f"**Invoked Agent Result** (forked session: {fork.session_id})\n\n{last_response}")
                }
            ]
        }
        
    return handler