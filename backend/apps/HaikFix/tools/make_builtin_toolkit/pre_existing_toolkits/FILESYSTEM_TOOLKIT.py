from backend.apps.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.HaikFix.tools.shared_structs.Tool import Tool

FILESYSTEM_TOOLKIT = Toolkit(
    name="filesystem",
    description="Tools for interacting with the filesystem",
    tools=[
        Tool(name="Read", deferred=False, permission="allow"),
        Tool(name="Edit", deferred=False, permission="allow"),
        Tool(name="Write", deferred=False, permission="allow"),
        Tool(name="NotebookEdit", deferred=True, permission="allow"),
    ]
)