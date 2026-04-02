from typing import Dict, Any, TypedDict
from typeguard import typechecked

from backend.apps.agents.HaikFix.Agent.shared_structs.Message.Message import Message
from backend.apps.agents.HaikFix.Agent.Agent import Agent


class CreateAgentInput(TypedDict):
    task: str

@typechecked
def make_create_agent_handler(parent: Agent):
    async def handler(args: CreateAgentInput) -> Dict[str, Any]:
        task_message = args["task"]
        if not task_message:
            return {"content": [{"type": "text", "text": "Error: task is required"}], "is_error": True}

        child = Agent(
            model=parent.model,
            mode=parent.mode,
            status="completed",
            config=parent.config,
            parent_id=parent.session_id,
        )
        parent.sub_agents.append(child)

        msg = Message(role="user", content=task_message, branch_id=child.branch_id)
        await child.send_message(msg)

        # Wait for the child to finish
        if child.task:
            await child.task

        # Extract last assistant response
        last_response = "No response from sub-agent."
        for m in reversed(child.messages.messages):
            if m.role == "assistant" and isinstance(m.content, str):
                last_response = m.content
                break

        return {"content": [{"type": "text", "text": (
            f"**Sub-Agent Result** (session: {child.session_id})\n\n{last_response}"
        )}]}

    return handler