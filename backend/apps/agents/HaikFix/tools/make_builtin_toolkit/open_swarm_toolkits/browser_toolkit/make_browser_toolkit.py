from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_actions_toolkit.make_browser_actions_toolkit import make_browser_actions_toolkit
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.make_browser_delegation_toolkit import make_browser_delegation_toolkit
from backend.apps.agents.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.agents.HaikFix.tools.shared_structs.MCP_Tool import SDK_MCP_Tool
from typing import Dict
from backend.apps.agents.HaikFix.Agent.Agent import Agent


def make_browser_toolkit(
    parent: Agent,
) -> Toolkit:
    return Toolkit(
        name="browser",
        description="Tools for browser automation",
        nested_toolkits=[
            make_browser_delegation_toolkit(parent),
            make_browser_actions_toolkit(parent),
        ],
    )