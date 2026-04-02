from backend.apps.agents.HaikFix.tools.Tool import Tool, Toolkit

SYSTEM_TOOLKIT = Toolkit(
    name="system",
    description="Tools for interacting with the system",
    tools=[
        Tool(name="Bash", deferred=False, permission="allow"),
        Tool(name="EnterWorktree", deferred=False, permission="allow"),
        Tool(name="TaskOutput", deferred=False, permission="allow"),
        Tool(name="TaskStop", deferred=False, permission="allow"),
    ]
)