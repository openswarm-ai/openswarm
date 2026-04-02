from backend.apps.agents.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.agents.HaikFix.tools.shared_structs.Tool import Tool

PLANNING_TOOLKIT = Toolkit(
    name="planning",
    description="Tools for planning",
    tools=[
        Tool(name="TodoWrite", deferred=False, permission="allow"),
        Tool(name="EnterPlanMode", deferred=False, permission="allow"),
        Tool(name="ExitPlanMode", deferred=False, permission="allow"),
    ]
)