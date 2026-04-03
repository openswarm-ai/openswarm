# BUILTIN_TOOLKIT.py

from typing import Dict
from typeguard import typechecked
from backend.core.tools.shared_structs.Toolkit import Toolkit
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.agents_toolkit.make_agents_toolkit import make_agents_toolkit
from backend.core.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_toolkit import make_browser_toolkit

from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.basic_toolkits.FILESYSTEM_TOOLKIT import FILESYSTEM_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.meta_toolkits.INTERACTION_TOOLKIT import INTERACTION_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.meta_toolkits.PLANNING_TOOLKIT import PLANNING_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.meta_toolkits.SCHEDULING_TOOLKIT import SCHEDULING_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.basic_toolkits.SEARCH_TOOLKIT import SEARCH_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.basic_toolkits.SYSTEM_TOOLKIT import SYSTEM_TOOLKIT
from backend.core.Agent.Agent import Agent

@typechecked
def make_builtin_toolkit(
    parent: Agent,
    agent_registry: Dict[str, Agent],
) -> Toolkit:
    return Toolkit(
        name="builtin",
        description="Builtin tools",
        nested_toolkits=[
            make_agents_toolkit(parent, agent_registry),
            make_browser_toolkit(parent),
            FILESYSTEM_TOOLKIT,
            INTERACTION_TOOLKIT,
            PLANNING_TOOLKIT,
            SCHEDULING_TOOLKIT,
            SEARCH_TOOLKIT,
            SYSTEM_TOOLKIT,
        ],
    )