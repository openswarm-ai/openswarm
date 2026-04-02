# BUILTIN_TOOLKIT.py

from typing import Dict
from backend.apps.agents.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.AGENTS_TOOLKIT import make_agents_toolkit
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.FILESYSTEM_TOOLKIT import FILESYSTEM_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.INTERACTION_TOOLKIT import INTERACTION_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.PLANNING_TOOLKIT import PLANNING_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.SCHEDULING_TOOLKIT import SCHEDULING_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.SEARCH_TOOLKIT import SEARCH_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.SYSTEM_TOOLKIT import SYSTEM_TOOLKIT
from backend.apps.agents.HaikFix.Agent.Agent import Agent


def make_builtin_toolkit(parent: Agent, agent_registry: Dict[str, Agent]) -> Toolkit:
    return Toolkit(
        name="builtin",
        description="Builtin tools",
        nested_toolkits=[
            make_agents_toolkit(parent, agent_registry),
            FILESYSTEM_TOOLKIT,
            INTERACTION_TOOLKIT,
            PLANNING_TOOLKIT,
            SCHEDULING_TOOLKIT,
            SEARCH_TOOLKIT,
            SYSTEM_TOOLKIT,
        ],
    )