from backend.apps.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.HaikFix.tools.shared_structs.Tool import Tool

INTERACTION_TOOLKIT = Toolkit(
    name="interaction",
    description="Tools for interacting with the user",
    tools=[
        Tool(name="AskUserQuestion", deferred=False, permission="allow"),
    ]
)