from backend.apps.agents.HaikFix.tools.Tool import Tool, Toolkit

AGENTS_TOOLKIT = Toolkit(
    name="agents",
    description="Tools for creating and invoking agents",
    tools=[
        Tool(name="CreateAgent", deferred=False, permission="allow"),
        Tool(name="InvokeAgent", deferred=False, permission="allow"),
    ]
)