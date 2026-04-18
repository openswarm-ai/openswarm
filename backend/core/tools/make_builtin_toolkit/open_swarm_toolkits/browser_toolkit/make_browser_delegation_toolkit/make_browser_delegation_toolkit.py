from typing import Optional, Callable
from typeguard import typechecked
from backend.core.tools.shared_structs.Toolkit import Toolkit
from backend.core.tools.shared_structs.MCP_Tool import SDK_MCP_Tool
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.make_create_browser_agent_handler import (
    make_create_browser_agent_handler, CreateBrowserAgentInput,
)
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.handlers.make_invoke_browser_agent_handler import (
    make_invoke_browser_agent_handler, InvokeBrowserAgentInput,
)
from backend.core.Agent.Agent import Agent
from backend.core.shared_structs.browser.BrowserCommandFn import BrowserCommandFn
from backend.core.shared_structs.dashboard.Dashboard import Dashboard

@typechecked
def make_browser_delegation_toolkit(
    parent: Agent,
    send_command: BrowserCommandFn,
    load_dashboard: Optional[Callable[[str], Dashboard]] = None,
    save_dashboard: Optional[Callable[[Dashboard], None]] = None,
) -> Toolkit:
    return Toolkit(
        name="browser",
        description="Tools for browser automation",
        tools=[
            SDK_MCP_Tool(
                name="CreateBrowserAgent",
                description=(
                    "Create a new browser and run a task on it. A dedicated browser agent "
                    "will autonomously navigate, click, type, and return a summary plus screenshot."
                ),
                deferred=False,
                permission="allow",
                server_name="openswarm-browser",
                input_schema=CreateBrowserAgentInput,
                handler=make_create_browser_agent_handler(
                    parent, send_command,
                    load_dashboard=load_dashboard,
                    save_dashboard=save_dashboard,
                ),
            ),
            SDK_MCP_Tool(
                name="InvokeBrowserAgent",
                description=(
                    "Run a task on an existing browser. The browser agent will autonomously "
                    "perform the task and return a summary plus screenshot."
                ),
                deferred=False,
                permission="allow",
                server_name="openswarm-browser",
                input_schema=InvokeBrowserAgentInput,
                handler=make_invoke_browser_agent_handler(parent, send_command),
            ),
        ],
    )