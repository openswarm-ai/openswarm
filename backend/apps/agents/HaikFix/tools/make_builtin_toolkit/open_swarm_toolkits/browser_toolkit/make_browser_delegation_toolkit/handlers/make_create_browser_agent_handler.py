import asyncio
from typing import TypedDict
from typeguard import typechecked

from backend.apps.agents.HaikFix.Agent.shared_structs.Message.agent_outputs import ToolResponse
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.utils.run_browser_loop import run_browser_loop
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.utils.format_browser_result import format_browser_result
from backend.apps.agents.HaikFix.Agent.Agent import Agent

# NOTE: Legacy dependancy. TODO: fix this shit cuh
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.utils.temp_sub_utils.create_browser_card import create_browser_card

class CreateBrowserAgentInput(TypedDict):
    task: str

@typechecked
def make_create_browser_agent_handler(
    parent: Agent,
    dashboard_id: str,
):
    async def handler(args: CreateBrowserAgentInput) -> ToolResponse:
        task = args["task"]

        browser_id = await create_browser_card(
            dashboard_id=dashboard_id,
        )
        if not browser_id:
            return {
                "content": [
                    {
                        "type": "text",
                        "text": "Error: failed to create browser agent",
                    },
                ],
                "is_error": True,
            }

        await asyncio.sleep(2.0)

        result = await run_browser_loop(
            task=task,
            browser_id=browser_id,
            model=parent.model,
        )

        return format_browser_result(result, browser_id)

    return handler