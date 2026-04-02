from typing import TypedDict
from typeguard import typechecked

from backend.apps.agents.HaikFix.Agent.shared_structs.Message.agent_outputs import ToolResponse
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.handlers.utils.run_browser_loop import run_browser_loop
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.handlers.utils.format_browser_result import format_browser_result
from backend.apps.agents.HaikFix.Agent.Agent import Agent


class InvokeBrowserAgentInput(TypedDict):
    browser_id: str
    task: str


@typechecked
def make_invoke_browser_agent_handler(parent: Agent):
    async def handler(args: InvokeBrowserAgentInput) -> ToolResponse:
        browser_id = args["browser_id"]
        task = args["task"]

        result = await run_browser_loop(
            task=task,
            browser_id=browser_id,
            model=parent.model,
        )

        return format_browser_result(result, browser_id)

    return handler