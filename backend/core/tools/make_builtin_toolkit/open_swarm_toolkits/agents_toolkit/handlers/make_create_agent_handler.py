from typing import TypedDict
from typeguard import typechecked

from backend.core.Agent.shared_structs.Message.agent_outputs import ToolResponse
from backend.core.Agent.shared_structs.Message.Message import (
    AnyMessage, UserMessage, AssistantMessage,
)
from backend.core.Agent.Agent import Agent

class CreateAgentInput(TypedDict):
    task: str

@typechecked
def make_create_agent_handler(parent: Agent):
    
    async def handler(args: CreateAgentInput) -> ToolResponse:
        task_message = args["task"]
        child = Agent(
            model=parent.model,
            mode=parent.mode,
            status="completed",
            config=parent.config,
            parent_id=parent.session_id,
        )
        parent.sub_agents.append(child)
        msg = UserMessage(content=task_message, branch_id=child.branch_id)
        await child.send_message(msg)
        if child.task:
            await child.task
        last_response = "No response from sub-agent."
        for m in reversed[AnyMessage](child.messages.messages):
            if isinstance(m, AssistantMessage):
                last_response = m.content
                break
        return {
            "content": [
                {
                    "type": "text", 
                    "text": (f"**Sub-Agent Result** (session: {child.session_id})\n\n{last_response}")
                }
            ]
        }

    return handler