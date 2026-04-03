import asyncio
from typing import TypedDict
from typeguard import typechecked

from backend.core.shared_structs.agent.Message.agent_outputs import ToolResponse
from backend.core.Agent.Agent import Agent
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.utils.run_browser_agent import run_browser_agent
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.utils.create_browser_card import create_browser_card
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_actions_toolkit.handlers.make_browser_action_handler import BrowserCommandFn


class CreateBrowserAgentInput(TypedDict):
    task: str


@typechecked
def make_create_browser_agent_handler(parent: Agent, send_command: BrowserCommandFn, dashboard_id: str = ""):

    async def handler(args: CreateBrowserAgentInput) -> ToolResponse:
        task: str = args["task"]

        browser_id: str = await create_browser_card(dashboard_id=dashboard_id)
        if not browser_id:
            return {
                "content": [{"type": "text", "text": "Error: failed to create browser agent"}],
                "is_error": True,
            }

        await asyncio.sleep(2.0)

        response = await run_browser_agent(parent=parent, browser_id=browser_id, task=task, send_command=send_command)

        return {
            "content": [
                {
                    "type": "text",
                    "text": f"**Browser Agent Result** (browser: {browser_id})\n\n{response}",
                }
            ],
        }

    return handler