from typing import TypedDict
from typeguard import typechecked

from backend.apps.agents.HaikFix.Agent.shared_structs.Message.agent_outputs import ToolResponse
from backend.apps.agents.HaikFix.Agent.Agent import Agent
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.utils.run_browser_agent import run_browser_agent


class InvokeBrowserAgentInput(TypedDict):
    browser_id: str
    task: str


@typechecked
def make_invoke_browser_agent_handler(parent: Agent):

    async def handler(args: InvokeBrowserAgentInput) -> ToolResponse:
        browser_id: str = args["browser_id"]
        task: str = args["task"]

        response = await run_browser_agent(parent=parent, browser_id=browser_id, task=task)

        return {
            "content": [
                {
                    "type": "text",
                    "text": f"**Browser Agent Result** (browser: {browser_id})\n\n{response}",
                }
            ],
        }

    return handler