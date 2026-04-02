from backend.apps.agents.HaikFix.tools.Tool import Tool, Toolkit

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