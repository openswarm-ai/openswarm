from backend.apps.agents.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.agents.HaikFix.tools.shared_structs.Tool import Tool

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