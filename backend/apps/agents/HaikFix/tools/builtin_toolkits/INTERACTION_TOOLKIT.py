from backend.apps.agents.HaikFix.tools.Tool import Tool, Toolkit

INTERACTION_TOOLKIT = Toolkit(
    name="interaction",
    description="Tools for interacting with the user",
    tools=[
        Tool(name="AskUserQuestion", deferred=False, permission="allow"),
    ]
)