from backend.apps.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_actions_toolkit.make_browser_actions_toolkit import make_browser_actions_toolkit
from backend.apps.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.make_browser_delegation_toolkit import make_browser_delegation_toolkit
from backend.apps.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.HaikFix.Agent.Agent import Agent

# # NOTE: The minor issue here is that with the current setup, any agent will prly have access to the browser actions toolkit, idk if this bad or good but for now its fine ig

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