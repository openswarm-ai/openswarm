from backend.apps.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.HaikFix.tools.shared_structs.Tool import Tool

SCHEDULING_TOOLKIT = Toolkit(
    name="scheduling",
    description="Tools for scheduling tasks",
    tools=[
        Tool(name="CronCreate", deferred=False, permission="allow"),
        Tool(name="CronList", deferred=False, permission="allow"),
        Tool(name="CronDelete", deferred=False, permission="allow"),
        Tool(name="ExitPlanMode", deferred=False, permission="allow"),
    ]
)