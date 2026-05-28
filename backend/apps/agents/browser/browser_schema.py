"""
Static schema + prompt blob for the browser sub-agent.

One big single-responsibility constant file: tool schema, action map, system
prompt, and the turn/report invariants. Exceeds the 300-LOC soft ceiling on
purpose because it is one cohesive data blob, not multiple responsibilities.
"""

MODEL_MAP = {
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-6",
    "haiku": "claude-haiku-4-5-20251001",
}

BROWSER_TOOLS_SCHEMA = [
    {
        "name": "ReportProgress",
        "description": (
            "Record your assessment of the previous action and your plan for the "
            "next one. You MUST call this BEFORE any browser action tools in every "
            "turn (after the very first turn). This is how you reflect on what just "
            "happened, track what you've learned about this site, and articulate what "
            "you're trying to do next. Skipping it is not allowed and will be rejected."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "evaluation_previous": {
                    "type": "string",
                    "description": (
                        "What did the previous action(s) accomplish? Did they succeed? "
                        "If not, why? Be specific about what changed on the page."
                    ),
                },
                "working_memory": {
                    "type": "string",
                    "description": (
                        "Short notes about what you've learned about this site so far; "
                        "selectors that work, keyboard shortcuts, layout quirks, what "
                        "you've tried that failed. Carry this forward across turns."
                    ),
                },
                "next_goal": {
                    "type": "string",
                    "description": (
                        "What you're trying to achieve with the action(s) you're about "
                        "to take next. Be concrete."
                    ),
                },
            },
            "required": ["evaluation_previous", "working_memory", "next_goal"],
        },
    },
    {
        "name": "BrowserScreenshot",
        "description": (
            "Capture a screenshot of the browser page. Returns the screenshot as a "
            "base64-encoded PNG image. Use this to see what is currently displayed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "BrowserGetText",
        "description": (
            "Get the visible text content of the browser page. Returns up to 15000 characters."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "BrowserNavigate",
        "description": "Navigate the browser to a URL.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The URL to navigate to."},
            },
            "required": ["url"],
        },
    },
    {
        "name": "BrowserClick",
        "description": "Click an element identified by a CSS selector. Use BrowserGetElements first to discover valid selectors.",
        "input_schema": {
            "type": "object",
            "properties": {
                "selector": {"type": "string", "description": "CSS selector of the element to click."},
            },
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
            "properties": {
                "expression": {"type": "string", "description": "JavaScript expression to evaluate."},
            },
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
            "container (works on SPAs like Notion, Gmail, etc. that use nested scroll "
            "containers instead of window-level scrolling). Returns scroll position info "
            "including whether top/bottom has been reached."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "direction": {
                    "type": "string",
                    "enum": ["up", "down"],
                    "description": "Scroll direction. Defaults to 'down'.",
                },
                "amount": {
                    "type": "number",
                    "description": "Pixels to scroll. Defaults to 500.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "BrowserListInteractives",
        "description": (
            "Get a NUMBERED LIST of interactive elements on the page using the "
            "browser's accessibility tree. Returns elements like [1]<button \"Like\">, "
            "[2]<link \"Settings\">, etc. Use this BEFORE BrowserClickIndex. This is "
            "the PREFERRED way to discover clickable elements on hostile sites "
            "(Tinder, Instagram, TikTok) where CSS selectors fail because the page "
            "uses unlabeled <div>s; the accessibility tree sees roles and names "
            "even when raw HTML doesn't expose them. Much more reliable than "
            "BrowserGetElements (which uses CSS selectors)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "BrowserClickIndex",
        "description": (
            "Click an element by its numeric index from BrowserListInteractives. "
            "Uses native OS-level mouse events (event.isTrusted=true) so it works "
            "on sites that filter out synthetic JS events. Always call "
            "BrowserListInteractives first to get a fresh index list. If the click "
            "returns 'index no longer valid', the page changed; re-list and retry."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "integer",
                    "description": "The numeric index from BrowserListInteractives (1-based).",
                },
            },
            "required": ["index"],
        },
    },
    {
        "name": "BrowserBatch",
        "description": (
            "Run a sequence of browser actions in one tool call. Each sub-action "
            "is executed in order, with the URL captured before/after each one. "
            "If the URL changes mid-batch (the page navigated), the rest of the "
            "batch is aborted and you get a partial result. Use this when you "
            "have a known sequence; typing then pressing Enter, swiping multiple "
            "times, clicking through pagination. Max 5 actions per batch.\n\n"
            "Sub-action types and their params:\n"
            "- click_index: { index: int }\n"
            "- press_key: { key: str }\n"
            "- type: { selector: str, text: str }\n"
            "- click: { selector: str }\n"
            "- scroll: { direction?: 'up'|'down', amount?: int }\n"
            "- wait: { milliseconds?: int }\n"
            "- navigate: { url: str }\n\n"
            "Example: { actions: [{type: 'click_index', params: {index: 1}}, "
            "{type: 'wait', params: {milliseconds: 500}}, "
            "{type: 'press_key', params: {key: 'ArrowRight'}}] }"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "maxItems": 5,
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {
                                "type": "string",
                                "enum": ["click_index", "press_key", "type", "wait", "scroll", "navigate", "click"],
                            },
                            "params": {"type": "object"},
                        },
                        "required": ["type", "params"],
                    },
                },
            },
            "required": ["actions"],
        },
    },
    {
        "name": "BrowserPressKey",
        "description": (
            "Press a keyboard key (or key combination) on the page using a real native "
            "input event. Use this for keyboard shortcuts when JS-dispatched events get "
            "ignored; sites like Tinder, Slack, Notion, Gmail listen for trusted key "
            "events. Examples: 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Tab', "
            "'Space', single letters like 'a'. Prefer this over BrowserEvaluate with "
            "dispatchEvent for keyboard shortcuts."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": (
                        "The key to press. Use JS KeyboardEvent.key names like "
                        "'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab', 'Space', "
                        "'Backspace', or a single character like 'a'."
                    ),
                },
            },
            "required": ["key"],
        },
    },
    {
        "name": "BrowserWait",
        "description": (
            "Wait for a specified duration. Useful after navigation or actions that "
            "trigger page loads, animations, or async content rendering. "
            "Min 100ms, max 10000ms."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "milliseconds": {
                    "type": "number",
                    "description": "Duration to wait in milliseconds. Defaults to 1000.",
                },
            },
            "required": [],
        },
    },
    {
        "name": "RequestHumanIntervention",
        "description": (
            "Request the user's help when you encounter an obstacle you cannot solve "
            "programmatically; captchas, login prompts, cookie consent walls, "
            "two-factor authentication, or any blocking popup. The agent will pause "
            "until the user resolves the issue and clicks Continue."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "problem": {
                    "type": "string",
                    "description": (
                        "One short sentence describing the obstacle. Keep it under "
                        "15 words. Example: 'Login required; please sign in to X/Twitter.'"
                    ),
                },
                "instruction": {
                    "type": "string",
                    "description": (
                        "One short sentence telling the user what to do. Keep it under "
                        "15 words. Example: 'Log in with your credentials, then click Done.'"
                    ),
                },
            },
            "required": ["problem", "instruction"],
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
    "BrowserPressKey": "press_key",
    "BrowserListInteractives": "list_interactives",
    "BrowserClickIndex": "click_index",
    "BrowserBatch": "batch",
}

SYSTEM_PROMPT = (
    "You are a website-agnostic browser automation agent. You can operate on ANY "
    "website the user is signed into; social media, dating apps, email, productivity "
    "tools, dashboards, ecommerce, anything. Assume the user has already logged in.\n\n"

    "## Required output structure: ReportProgress before every action\n"
    "Before ANY action tool (BrowserClick, BrowserType, BrowserNavigate, "
    "BrowserPressKey, BrowserScroll, BrowserEvaluate, BrowserClickIndex, "
    "BrowserBatch), you MUST call the ReportProgress tool in the SAME turn. "
    "ReportProgress takes three short fields:\n"
    "- evaluation_previous: did your last action work? what changed on the page?\n"
    "- working_memory: what have you learned about this site? what worked, what didn't?\n"
    "- next_goal: what specifically are you trying to do with the next action?\n"
    "Emit ReportProgress and your action tool(s) together in the same response. "
    "If you skip ReportProgress, your action tools will be REJECTED with an error "
    "and you will have to retry. This is not optional. Read-only tools "
    "(BrowserScreenshot, BrowserGetText, BrowserGetElements, BrowserWait) do not "
    "require ReportProgress.\n\n"

    "## Loop awareness\n"
    "If you see a tool result containing 'LOOP DETECTED' or '⚠️', it means you "
    "have called the same tool with the same parameters and gotten the same "
    "result multiple times in a row. STOP. Do NOT retry the same approach. "
    "Switch strategy entirely: try a different tool, a different selector, "
    "keyboard shortcuts, or call RequestHumanIntervention if you genuinely "
    "cannot proceed. The loop detector will force-exit the agent if you "
    "ignore it more than 5 times.\n\n"

    "## Use prior context\n"
    "If this is a continuation of an earlier conversation on the same browser, the "
    "messages above already contain everything you've tried, what worked, what failed, "
    "and the page state. READ THAT HISTORY before acting. Do NOT take a fresh screenshot "
    "or re-explore the DOM if you already know what's on screen; just act. Only re-orient "
    "if the page has clearly changed (after navigation, after a multi-second wait, or if "
    "your last action mutated the page in unexpected ways).\n\n"

    "## Try multiple strategies, learn from failures\n"
    "Sites vary wildly. When one approach fails, switch tactics; don't retry the same "
    "thing. The escalation ladder, fastest to slowest:\n"
    "1. **Keyboard shortcuts via BrowserPressKey**; fastest and most reliable on sites "
    "that support them (Tinder swipes, Gmail navigation, Slack message jump, etc.). "
    "Always check if the site shows keyboard hints in the UI before falling back to clicks. "
    "BrowserPressKey sends real native events that pass the `event.isTrusted` check, so "
    "it works where dispatchEvent in BrowserEvaluate silently fails.\n"
    "2. **Accessibility tree via BrowserListInteractives + BrowserClickIndex**; the "
    "accessibility tree sees roles and names that the raw DOM doesn't, even on sites "
    "like Tinder, Instagram, and TikTok that use unlabeled <div>s with click handlers. "
    "Call BrowserListInteractives to get a numbered list (`[1]<button \"Like\">`, "
    "`[2]<link \"Settings\">`), then BrowserClickIndex with the number. The click uses "
    "native OS-level mouse events so it works where DOM .click() doesn't. THIS IS YOUR "
    "GO-TO STRATEGY for unlabeled or hostile sites; try this BEFORE BrowserGetElements.\n"
    "3. **Semantic CSS selectors**; `button[aria-label='X']`, `[role='button']`, "
    "`a[href*='...']`. Try these via BrowserGetElements + BrowserClick when the site "
    "actually has semantic HTML.\n"
    "4. **Text-based JS query**; when both of the above fail, use BrowserEvaluate to "
    "find elements by visible text: `Array.from(document.querySelectorAll('*')).find(el => el.textContent.trim() === 'Like')`.\n"
    "5. **Coordinate-based fallback**; last resort: take a screenshot, identify the "
    "button visually, then click by approximate coords.\n\n"

    "## Batch known sequences with BrowserBatch\n"
    "When you have a known sequence of actions; typing then pressing Enter, "
    "swiping multiple times, clicking through pagination; emit them all in a "
    "single BrowserBatch call instead of one tool per turn. The batch executes "
    "sub-actions sequentially and aborts if the URL changes mid-batch (so you "
    "won't operate on stale state). Max 5 sub-actions per batch.\n"
    "Use BrowserBatch when:\n"
    "- You're doing the same action repeatedly (5 swipes, 3 scrolls)\n"
    "- You have a deterministic flow (type query → press Enter → click first result)\n"
    "Don't use BrowserBatch when:\n"
    "- You need to read the page state between actions\n"
    "- You're uncertain about what comes next\n"
    "- An action might trigger an unexpected popup or navigation\n\n"

    "## Avoid wasted cycles\n"
    "- Do NOT screenshot after every single action. Screenshot ONLY when you genuinely "
    "don't know the page state (start of task, after navigation, after a failure).\n"
    "- Do NOT call BrowserGetElements on the entire body if you already know roughly "
    "where the target is. Scope it: `BrowserGetElements({selector: 'nav'})`.\n"
    "- Do NOT call the same failing tool twice with identical parameters. If selector "
    "X failed, try a DIFFERENT selector or a DIFFERENT strategy.\n"
    "- For repeated actions (swiping through profiles, going through inbox messages), "
    "use BrowserPressKey if available; it's an order of magnitude faster than DOM clicks.\n\n"

    "## When you genuinely cannot proceed\n"
    "Use RequestHumanIntervention for:\n"
    "- Login walls (the user thinks they're logged in but the session expired)\n"
    "- Captchas, 2FA prompts, age verification gates\n"
    "- Anything genuinely ambiguous about user intent\n"
    "Don't use it for normal tool failures; try a different approach first.\n\n"

    "## Tool reference\n"
    "- BrowserScreenshot: visual snapshot. Use sparingly, not after every action.\n"
    "- BrowserGetText: returns up to 15000 chars of visible text. Useful for reading "
    "content without an image.\n"
    "- BrowserScroll: handles nested scroll containers (Notion, Gmail). Returns "
    "atTop/atBottom; stop looping when scroll delta is 0.\n"
    "- BrowserGetElements: enumerate interactive elements with selectors.\n"
    "- BrowserClick / BrowserType: standard DOM interaction.\n"
    "- BrowserPressKey: native key events (preferred for shortcuts).\n"
    "- BrowserEvaluate: arbitrary JS for everything else, including text-based element "
    "search and reading state. Avoid for scrolling and keyboard events.\n"
    "- BrowserWait: 1-3s after navigation, 0.5s after most clicks.\n\n"

    "Complete the task autonomously and report a clear, brief summary."
)

MAX_TURNS = 40

# Tools that count as "action tools"; calling any of these in a turn requires
# the model to also call ReportProgress in the same turn (after the first
# turn). Read-only tools and meta tools are exempt.
_ACTION_TOOLS_REQUIRING_REPORT = {
    "BrowserClick",
    "BrowserType",
    "BrowserNavigate",
    "BrowserPressKey",
    "BrowserScroll",
    "BrowserEvaluate",
    "BrowserClickIndex",  # Phase 3
    "BrowserBatch",  # Phase 4
}
