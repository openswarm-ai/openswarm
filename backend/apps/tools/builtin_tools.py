"""Flat list of builtin tool metadata for the /builtin endpoint.

Derived from the existing pre_existing_toolkits constants so there is
a single source of truth for tool definitions.
"""

from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.basic_toolkits.FILESYSTEM_TOOLKIT import FILESYSTEM_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.basic_toolkits.SEARCH_TOOLKIT import SEARCH_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.basic_toolkits.SYSTEM_TOOLKIT import SYSTEM_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.meta_toolkits.INTERACTION_TOOLKIT import INTERACTION_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.meta_toolkits.PLANNING_TOOLKIT import PLANNING_TOOLKIT
from backend.core.tools.make_builtin_toolkit.pre_existing_toolkits.meta_toolkits.SCHEDULING_TOOLKIT import SCHEDULING_TOOLKIT
from backend.core.tools.shared_structs.Toolkit import Toolkit


def _collect_tools(toolkit: Toolkit, category: str) -> list[dict]:
    if toolkit.tools is None:
        return []
    return [
        {
            "name": t.name,
            "description": t.description or "",
            "category": category,
            "deferred": t.deferred,
        }
        for t in toolkit.tools
    ]


BUILTIN_TOOLS: list[dict] = [
    *_collect_tools(FILESYSTEM_TOOLKIT, "filesystem"),
    *_collect_tools(SYSTEM_TOOLKIT, "system"),
    *_collect_tools(SEARCH_TOOLKIT, "search"),
    *_collect_tools(INTERACTION_TOOLKIT, "interaction"),
    *_collect_tools(PLANNING_TOOLKIT, "planning"),
    *_collect_tools(SCHEDULING_TOOLKIT, "scheduling"),
    {"name": "CreateAgent", "description": "Spawn a sub-agent to handle a complex subtask", "category": "agents", "deferred": False},
    {"name": "InvokeAgent", "description": "Invoke a copy of an existing agent with a new message", "category": "agents", "deferred": False},
    {"name": "CreateBrowserAgent", "description": "Create a new browser and run a task on it", "category": "browser_delegation", "deferred": False},
    {"name": "BrowserAgent", "description": "Delegate a browser task to an existing browser agent", "category": "browser_delegation", "deferred": False},
    {"name": "BrowserScreenshot", "description": "Capture a screenshot of the browser page", "category": "browser_action", "deferred": False},
    {"name": "BrowserNavigate", "description": "Navigate the browser to a URL", "category": "browser_action", "deferred": False},
    {"name": "BrowserClick", "description": "Click an element by CSS selector", "category": "browser_action", "deferred": False},
    {"name": "BrowserType", "description": "Type text into an input element", "category": "browser_action", "deferred": False},
    {"name": "BrowserEvaluate", "description": "Execute JavaScript in the browser", "category": "browser_action", "deferred": False},
    {"name": "BrowserGetText", "description": "Get visible text content of the page", "category": "browser_action", "deferred": False},
    {"name": "BrowserGetElements", "description": "List interactive elements with CSS selectors", "category": "browser_action", "deferred": False},
    {"name": "BrowserScroll", "description": "Scroll the page up or down", "category": "browser_action", "deferred": False},
    {"name": "BrowserWait", "description": "Wait for page loads or animations", "category": "browser_action", "deferred": False},
]
