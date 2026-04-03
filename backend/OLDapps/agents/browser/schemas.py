"""Browser tool schemas, constants, and system prompt."""

BROWSER_TOOLS_SCHEMA = [
    {
        "name": "BrowserScreenshot",
        "description": (
            "Capture a screenshot of the browser page. Returns the screenshot as a "
            "base64-encoded PNG image. Use this to see what is currently displayed."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "BrowserGetText",
        "description": "Get the visible text content of the browser page. Returns up to 15000 characters.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "BrowserNavigate",
        "description": "Navigate the browser to a URL.",
        "input_schema": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "The URL to navigate to."}},
            "required": ["url"],
        },
    },
    {
        "name": "BrowserClick",
        "description": "Click an element identified by a CSS selector. Use BrowserGetElements first to discover valid selectors.",
        "input_schema": {
            "type": "object",
            "properties": {"selector": {"type": "string", "description": "CSS selector of the element to click."}},
            "required": ["selector"],
        },
    },
    {
        "name": "BrowserType",
        "description": "Type text into an input element. Clears existing value first.",
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "CSS selector of the input element."},
                "text": {"type": "string", "description": "The text to type."},
            },
            "required": ["selector", "text"],
        },
    },
    {
        "name": "BrowserEvaluate",
        "description": "Evaluate a JavaScript expression in the browser page and return the result.",
        "input_schema": {
            "type": "object",
            "properties": {"expression": {"type": "string", "description": "JavaScript expression to evaluate."}},
            "required": ["expression"],
        },
    },
    {
        "name": "BrowserGetElements",
        "description": (
            "Get a list of interactive elements on the page with CSS selectors. "
            "Call this BEFORE clicking or typing so you know which selectors are valid."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "Optional CSS selector to scope the search (e.g. 'form', '#main'). Defaults to 'body'.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "BrowserScroll",
        "description": (
            "Scroll the page up or down. Automatically finds the correct scrollable "
            "container. Returns scroll position info including whether top/bottom has been reached."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "direction": {"type": "string", "enum": ["up", "down"], "description": "Scroll direction. Defaults to 'down'."},
                "amount": {"type": "number", "description": "Pixels to scroll. Defaults to 500."},
            },
            "required": [],
        },
    },
    {
        "name": "BrowserWait",
        "description": (
            "Wait for a specified duration. Useful after navigation or actions that "
            "trigger page loads. Min 100ms, max 10000ms."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"milliseconds": {"type": "number", "description": "Duration to wait in milliseconds. Defaults to 1000."}},
            "required": [],
        },
    },
]

ACTION_MAP = {
    "BrowserScreenshot": "screenshot",
    "BrowserGetText": "get_text",
    "BrowserNavigate": "navigate",
    "BrowserClick": "click",
    "BrowserType": "type",
    "BrowserEvaluate": "evaluate",
    "BrowserGetElements": "get_elements",
    "BrowserScroll": "scroll",
    "BrowserWait": "wait",
}

SYSTEM_PROMPT = (
    "You are a browser automation agent. You control a single browser tab and "
    "execute the task you are given.\n\n"
    "Strategy:\n"
    "1. Start by taking a screenshot to understand the page.\n"
    "2. After navigation, use BrowserWait (1-3 seconds) to let the page finish loading.\n"
    "3. Use BrowserScroll to scroll through pages — do NOT use BrowserEvaluate with "
    "window.scrollBy() as many sites use nested scroll containers that BrowserScroll "
    "handles automatically.\n"
    "4. Use BrowserGetElements BEFORE clicking or typing to discover valid CSS selectors.\n"
    "5. After performing actions, take a screenshot to verify the result.\n"
    "6. If an action fails, try alternative selectors or approaches.\n"
    "7. When the task is complete, provide a clear summary of what you accomplished.\n\n"
    "Important notes:\n"
    "- BrowserGetText returns up to 15000 chars of visible text — use it to read page content.\n"
    "- BrowserScroll returns position info including atTop/atBottom — use this to know when "
    "you've reached the end of the page.\n"
    "- For complex SPAs (Notion, Gmail, etc.), prefer BrowserScroll over BrowserEvaluate for scrolling.\n"
    "- Avoid looping: if scrolling shows no new content (scrolled 0px), you're at the boundary.\n\n"
    "You have access ONLY to browser tools. Do not ask the user questions — "
    "complete the task autonomously to the best of your ability."
)

MAX_TURNS = 25
