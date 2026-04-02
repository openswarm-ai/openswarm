from backend.apps.agents.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.agents.HaikFix.tools.shared_structs.Tool import Tool

SEARCH_TOOLKIT = Toolkit(
    name="search",
    description="Tools for searching the web and files",
    tools=[
        Tool(name="Glob", deferred=False, permission="allow"),
        Tool(name="Grep", deferred=False, permission="allow"),
        Tool(name="WebSearch", deferred=True, permission="allow"),
        Tool(name="WebFetch", deferred=True, permission="allow"),
    ]
)