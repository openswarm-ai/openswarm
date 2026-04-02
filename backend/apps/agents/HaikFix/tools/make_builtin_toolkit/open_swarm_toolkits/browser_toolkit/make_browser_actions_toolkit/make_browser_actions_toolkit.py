from typeguard import typechecked
from backend.apps.agents.HaikFix.tools.shared_structs.Toolkit import Toolkit
from backend.apps.agents.HaikFix.tools.shared_structs.MCP_Tool import SDK_MCP_Tool
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_actions_toolkit.handlers.browser_action_input_schemas import (
    BrowserScreenshotInput,
    BrowserGetTextInput,
    BrowserNavigateInput,
    BrowserClickInput,
    BrowserTypeInput,
    BrowserEvaluateInput,
    BrowserGetElementsInput,
    BrowserScrollInput,
    BrowserWaitInput,
)
from backend.apps.agents.HaikFix.tools.make_builtin_toolkit.open_swarm_toolkits.browser_toolkit.make_browser_actions_toolkit.handlers.make_browser_action_handler import make_browser_action_handler

SERVER_NAME = "openswarm-browser-actions"

@typechecked
def make_browser_actions_toolkit(browser_id: str, tab_id: str = "") -> Toolkit:
    return Toolkit(
        name="browser_actions",
        description="Low-level browser automation actions for a single browser tab",
        tools=[
            SDK_MCP_Tool(
                name="BrowserScreenshot",
                description=(
                    "Capture a screenshot of the browser page. Returns the screenshot as a "
                    "base64-encoded PNG image. Use this to see what is currently displayed."
                ),
                deferred=False,
                permission="allow",
                server_name=SERVER_NAME,
                input_schema=BrowserScreenshotInput,
                handler=make_browser_action_handler("BrowserScreenshot", browser_id, tab_id),
            ),
            SDK_MCP_Tool(
                name="BrowserGetText",
                description="Get the visible text content of the browser page. Returns up to 15000 characters.",
                deferred=False,
                permission="allow",
                server_name=SERVER_NAME,
                input_schema=BrowserGetTextInput,
                handler=make_browser_action_handler("BrowserGetText", browser_id, tab_id),
            ),
            SDK_MCP_Tool(
                name="BrowserNavigate",
                description="Navigate the browser to a URL.",
                deferred=False,
                permission="allow",
                server_name=SERVER_NAME,
                input_schema=BrowserNavigateInput,
                handler=make_browser_action_handler("BrowserNavigate", browser_id, tab_id),
            ),
            SDK_MCP_Tool(
                name="BrowserClick",
                description=(
                    "Click an element identified by a CSS selector. "
                    "Use BrowserGetElements first to discover valid selectors."
                ),
                deferred=False,
                permission="allow",
                server_name=SERVER_NAME,
                input_schema=BrowserClickInput,
                handler=make_browser_action_handler("BrowserClick", browser_id, tab_id),
            ),
            SDK_MCP_Tool(
                name="BrowserType",
                description="Type text into an input element. Clears existing value first.",
                deferred=False,
                permission="allow",
                server_name=SERVER_NAME,
                input_schema=BrowserTypeInput,
                handler=make_browser_action_handler("BrowserType", browser_id, tab_id),
            ),
            SDK_MCP_Tool(
                name="BrowserEvaluate",
                description="Evaluate a JavaScript expression in the browser page and return the result.",
                deferred=False,
                permission="allow",
                server_name=SERVER_NAME,
                input_schema=BrowserEvaluateInput,
                handler=make_browser_action_handler("BrowserEvaluate", browser_id, tab_id),
            ),
            SDK_MCP_Tool(
                name="BrowserGetElements",
                description=(
                    "Get a list of interactive elements on the page with CSS selectors. "
                    "Call this BEFORE clicking or typing so you know which selectors are valid."
                ),
                deferred=False,
                permission="allow",
                server_name=SERVER_NAME,
                input_schema=BrowserGetElementsInput,
                handler=make_browser_action_handler("BrowserGetElements", browser_id, tab_id),
            ),
            SDK_MCP_Tool(
                name="BrowserScroll",
                description=(
                    "Scroll the page up or down. Automatically finds the correct scrollable "
                    "container. Returns scroll position info including whether top/bottom has been reached."
                ),
                deferred=False,
                permission="allow",
                server_name=SERVER_NAME,
                input_schema=BrowserScrollInput,
                handler=make_browser_action_handler("BrowserScroll", browser_id, tab_id),
            ),
            SDK_MCP_Tool(
                name="BrowserWait",
                description=(
                    "Wait for a specified duration. Useful after navigation or actions that "
                    "trigger page loads. Min 100ms, max 10000ms."
                ),
                deferred=False,
                permission="allow",
                server_name=SERVER_NAME,
                input_schema=BrowserWaitInput,
                handler=make_browser_action_handler("BrowserWait", browser_id, tab_id),
            ),
        ],
    )