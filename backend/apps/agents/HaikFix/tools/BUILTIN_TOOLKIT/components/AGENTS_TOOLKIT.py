from backend.apps.agents.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.agents.HaikFix.tools.shared_structs.Tool import Tool

AGENTS_TOOLKIT = Toolkit(
    name="agents",
    description="Tools for creating and invoking agents",
    tools=[
        Tool(name="CreateAgent", deferred=False, permission="allow"),
        Tool(name="InvokeAgent", deferred=False, permission="allow"),
    ]
)