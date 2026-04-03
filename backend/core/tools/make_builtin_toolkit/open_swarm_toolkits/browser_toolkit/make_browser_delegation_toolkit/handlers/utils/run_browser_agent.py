from typing import List, Dict
from typeguard import typechecked

from claude_agent_sdk import ClaudeAgentOptions
from claude_agent_sdk.types import McpServerConfig

from backend.core.Agent.Agent import Agent
from backend.core.Agent.shared_structs.Message.Message import (
    UserMessage, AssistantMessage, AnyMessage,
)
from backend.core.tools.shared_structs.MCP_Tool import SDK_MCP_Tool
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_actions_toolkit.make_browser_actions_toolkit import make_browser_actions_toolkit
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.utils.constants import BROWSER_AGENT_SYSTEM_PROMPT


@typechecked
async def run_browser_agent(
    parent: Agent,
    browser_id: str,
    task: str,
    tab_id: str = "",
) -> str:
    """Spin up a child Agent with browser action tools, run a task, return the response text."""

    actions_toolkit = make_browser_actions_toolkit(browser_id=browser_id, tab_id=tab_id)

    mcp_servers: Dict[str, McpServerConfig] = {}
    tool_names: List[str] = []
    for tool in actions_toolkit.tools:
        assert isinstance(tool, SDK_MCP_Tool)
        mcp_servers.update(tool.to_mcp_server_config())
        tool_names.append(tool.to_sdk_args())

    browser_config = ClaudeAgentOptions(
        model=parent.model,
        system_prompt=BROWSER_AGENT_SYSTEM_PROMPT,
        tools=tool_names,
        mcp_servers=mcp_servers,
        max_turns=25,
    )

    child = Agent(
        model=parent.model,
        mode="browser",
        status="completed",
        config=browser_config,
        parent_id=parent.session_id,
    )
    parent.sub_agents.append(child)

    msg = UserMessage(content=task, branch_id=child.branch_id)
    await child.send_message(msg)
    if child.task:
        await child.task

    for m in reversed[AnyMessage](child.messages.messages):
        if isinstance(m, AssistantMessage):
            return m.content

    return "Task completed."