from backend.apps.agents.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.agents.HaikFix.tools.shared_structs.Tool import Tool

from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.AGENTS_TOOLKIT import AGENTS_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.FILESYSTEM_TOOLKIT import FILESYSTEM_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.INTERACTION_TOOLKIT import INTERACTION_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.PLANNING_TOOLKIT import PLANNING_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.SCHEDULING_TOOLKIT import SCHEDULING_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.SEARCH_TOOLKIT import SEARCH_TOOLKIT
from backend.apps.agents.HaikFix.tools.BUILTIN_TOOLKIT.components.SYSTEM_TOOLKIT import SYSTEM_TOOLKIT

BUILTIN_TOOLKIT = Toolkit(
    name="builtin",
    description="Builtin tools",
    nested_toolkits=[
        AGENTS_TOOLKIT,
        FILESYSTEM_TOOLKIT,
        INTERACTION_TOOLKIT,
        PLANNING_TOOLKIT,
        SCHEDULING_TOOLKIT,
        SEARCH_TOOLKIT,
        SYSTEM_TOOLKIT,
    ]
)