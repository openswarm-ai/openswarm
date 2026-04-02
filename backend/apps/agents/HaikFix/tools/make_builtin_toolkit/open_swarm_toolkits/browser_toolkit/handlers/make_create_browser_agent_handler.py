import asyncio
import logging
from typing import TypedDict
from typing_extensions import NotRequired
from typeguard import typechecked

from backend.apps.agents.HaikFix.Agent.shared_structs.Message.agent_outputs import ToolResponse
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.handlers.utils.run_browser_loop import run_browser_loop
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.handlers.utils.format_browser_result import format_browser_result
from backend.apps.agents.HaikFix.Agent.Agent import Agent

class CreateBrowserAgentInput(TypedDict):
    task: str
    url: NotRequired[str]

@typechecked
def make_create_browser_agent_handler(
    parent: Agent,
    create_browser_card_fn,
):
    async def handler(args: CreateBrowserAgentInput) -> ToolResponse:
        task = args["task"]
        url = args.get("url", "")

        browser_id = await create_browser_card_fn(
            dashboard_id=parent.config.session_id or "",
            url=url,
            parent_session_id=parent.session_id,
        )
        if not browser_id:
            return {"content": [{"type": "text", "text": "Error: failed to create browser card"}], "is_error": True}

        await asyncio.sleep(2.0)

        result = await run_browser_loop(
            task=task,
            browser_id=browser_id,
            model=parent.model,
            initial_url=url,
        )

        return format_browser_result(result, browser_id)

    return handler