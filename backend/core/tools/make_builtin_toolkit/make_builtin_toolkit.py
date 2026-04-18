from typing import Dict, Optional, Callable
from typeguard import typechecked
from backend.core.tools.shared_structs.Toolkit import Toolkit
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.agents_toolkit.make_agents_toolkit import make_agents_toolkit
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_delegation_toolkit.make_browser_delegation_toolkit import make_browser_delegation_toolkit
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_actions_toolkit.make_browser_actions_toolkit import make_browser_actions_toolkit
from backend.core.shared_structs.browser.BrowserCommandFn import BrowserCommandFn

from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.basic_toolkits.FILESYSTEM_TOOLKIT import FILESYSTEM_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.meta_toolkits.INTERACTION_TOOLKIT import INTERACTION_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.meta_toolkits.PLANNING_TOOLKIT import PLANNING_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.meta_toolkits.SCHEDULING_TOOLKIT import SCHEDULING_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.basic_toolkits.SEARCH_TOOLKIT import SEARCH_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.basic_toolkits.SYSTEM_TOOLKIT import SYSTEM_TOOLKIT
from backend.core.Agent.Agent import Agent
from backend.core.shared_structs.dashboard.Dashboard import Dashboard

@typechecked
def make_builtin_toolkit(
    parent: Agent,
    agent_registry: Dict[str, Agent],
    send_browser_command: BrowserCommandFn,
    load_dashboard: Optional[Callable[[str], Dashboard]] = None,
    save_dashboard: Optional[Callable[[Dashboard], None]] = None,
) -> Toolkit:
    return Toolkit(
        name="builtin",
        description="Builtin tools",
        nested_toolkits=[
            make_agents_toolkit(parent, agent_registry),
            make_browser_delegation_toolkit(
                parent, send_browser_command,
                load_dashboard=load_dashboard,
                save_dashboard=save_dashboard,
            ),
            make_browser_actions_toolkit(parent.session_id, send_browser_command),
            FILESYSTEM_TOOLKIT,
            INTERACTION_TOOLKIT,
            PLANNING_TOOLKIT,
            SCHEDULING_TOOLKIT,
            SEARCH_TOOLKIT,
            SYSTEM_TOOLKIT,
        ],
    )