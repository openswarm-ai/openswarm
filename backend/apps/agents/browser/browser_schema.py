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
            "- navigate: { url: str }\n"
            "- list_interactives: { } (read the page; ONLY valid as the LAST sub-action)\n\n"
            "End a batch with list_interactives to fold a click -> wait -> read into "
            "ONE turn: e.g. click a button, wait for it to settle, then read the "
            "result, all without a second round-trip.\n"
            "Example: { actions: [{type: 'click_index', params: {index: 1}}, "
            "{type: 'wait', params: {milliseconds: 4000}}, "
            "{type: 'list_interactives', params: {}}] }"
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
                                "enum": ["click_index", "press_key", "type", "wait", "scroll", "navigate", "click", "list_interactives"],
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
            "Wait for the page to settle after navigation or an action that loads "
            "async content. This is SMART: it returns as soon as the page's network "
            "goes quiet, so the duration you give is just an upper bound, not a fixed "
            "sleep. Pass a generous cap (e.g. 4000) without worrying about wasted "
            "time; you usually get control back in a few hundred ms. Min 100, max 10000."
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
        "name": "BrowserListRoutes",
        "description": (
            "List the site's own API endpoints that were captured while you "
            "browsed it (GET routes, safe to call directly). When you need to "
            "re-fetch data you already loaded once (search results, a list, a "
            "detail page), calling the API with BrowserReplayRoute is far faster "
            "than re-navigating and re-scraping the UI. Returns nothing until "
            "you've actually used the page. Read-only."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "BrowserReplayRoute",
        "description": (
            "Directly call one of the site's captured GET endpoints (from "
            "BrowserListRoutes) and get the raw response, skipping the UI. "
            "ONLY safe read-only GET/HEAD requests on the current site are "
            "allowed; anything that changes data (add to cart, send, delete, "
            "post) must be done through the UI by clicking. Use this to read "
            "data fast, not to perform actions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The endpoint URL to GET (from BrowserListRoutes; same site only)."},
                "method": {"type": "string", "enum": ["GET", "HEAD"], "description": "Defaults to GET."},
            },
            "required": ["url"],
        },
    },
    {
        "name": "BrowserRepeatFlow",
        "description": (
            "Repeat a mechanical flow you JUST did, fast, for many inputs, without "
            "re-screenshotting or re-analyzing the page each time. After you've done "
            "ONE item the slow way (e.g. searched and read one person), call this "
            "with the step template and the remaining inputs and they run at machine "
            "speed: zero screenshots, zero extra thinking. Write the steps using "
            "{{value}} wherever the input varies. Each iteration is verified; any "
            "item whose page doesn't match falls back and is reported so you can "
            "handle it yourself, it never pretends. It HANDS BACK each item's read "
            "data (the last step's output, capped), keyed by value, so a read loop "
            "actually delivers ('Read 5 of 5: - ada: ...'). Use this for SEARCH / "
            "READ / NAVIGATE loops. It REFUSES irreversible steps (Send, Submit, "
            "Connect, Post, Pay, Delete, message composers): do those one at a time. "
            "For reading data, a 'replay_route' step (hit a captured API endpoint) is "
            "far faster and cheaper than navigating the UI per item."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "description": "The flow for ONE item, in order. Put {{value}} where the input varies.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "action": {"type": "string", "enum": ["navigate", "get_text", "evaluate", "type", "click", "press_key", "scroll", "replay_route"]},
                            "url": {"type": "string", "description": "for navigate / replay_route"},
                            "selector": {"type": "string", "description": "for type"},
                            "text": {"type": "string", "description": "for type"},
                            "role": {"type": "string", "description": "for click (e.g. button, link)"},
                            "name": {"type": "string", "description": "for click: the visible text"},
                            "key": {"type": "string", "description": "for press_key (e.g. Enter)"},
                            "expression": {"type": "string", "description": "for evaluate (JS)"},
                            "direction": {"type": "string", "description": "for scroll"},
                            "amount": {"type": "integer", "description": "for scroll"},
                        },
                        "required": ["action"],
                    },
                },
                "values": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "The inputs to run the flow for (the remaining items after the one you already did).",
                },
            },
            "required": ["steps", "values"],
        },
    },
    {
        "name": "BrowserDetectWebMCP",
        "description": (
            "Check whether the current page declares its own WebMCP tools "
            "(navigator.modelContext). If a site exposes tools this way, they "
            "are the fastest, most reliable path; prefer them over scraping the "
            "UI. Most sites don't support this yet, so it usually reports none; "
            "in that case just use the normal browser tools. Read-only."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "BrowserListSkills",
        "description": (
            "List the shortcuts (learned skills) you already have for the CURRENT "
            "site. Each is a previously-completed task you can repeat fast. Useful "
            "when a task feels familiar: a near-match skill may let you adapt "
            "instead of figuring the site out from scratch. Returns task summaries "
            "+ how many times each has been reused. Read-only."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "BrowserDeprecateSkill",
        "description": (
            "Throw away a learned shortcut for this site that has gone stale (the "
            "page changed, or replaying it no longer works), so it stops being "
            "used. Pass the task text exactly as shown by BrowserListSkills. Use "
            "this when you realize a saved shortcut is wrong; the correct version "
            "will be re-learned the next time you do the task successfully."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "task": {"type": "string", "description": "The skill's task text (from BrowserListSkills) to remove."},
            },
            "required": ["task"],
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
    "BrowserDetectWebMCP": "detect_webmcp",
    "BrowserListRoutes": "list_routes",
    "BrowserReplayRoute": "replay_route",
    # Internal replay primitive (skill replay calls it directly; not in the
    # LLM-facing schema). Re-resolves a click target by role+name.
    "BrowserClickByName": "click_by_name",
}

SYSTEM_PROMPT = (
    "You are a website-agnostic browser automation agent. You can operate on ANY "
    "website the user is signed into; social media, dating apps, email, productivity "
    "tools, dashboards, ecommerce, anything. Assume the user has already logged in.\n\n"

    "## Plan once up front, then execute tersely (this is how you stay fast)\n"
    "Your first turn or two, once you can see the starting page, is your ONE planning "
    "window: lay out the whole route in a few lines, the navigations, which buttons and "
    "links you expect to click, what you'll read, and roughly where they sit. Treat it as "
    "a guideline, not a contract: the live page may differ and you'll adjust, that's fine. "
    "This plan stays in the conversation history, so you never re-derive it.\n"
    "After that, go TERSE. Every later turn is mostly action, not narration: fire the next "
    "step (batched whenever the sequence is known, see BrowserBatch) with a one-line note, "
    "and lean on the plan already in context instead of re-explaining it. Re-plan out loud "
    "ONLY when the page clearly contradicts your plan. Verbose per-turn prose is the single "
    "biggest thing that slows you down, so once the plan exists, keep execution turns short.\n\n"

    "## Required output structure: ReportProgress before every action\n"
    "Before ANY action tool (BrowserClick, BrowserType, BrowserNavigate, "
    "BrowserPressKey, BrowserScroll, BrowserEvaluate, BrowserClickIndex, "
    "BrowserBatch), you MUST call the ReportProgress tool in the SAME turn. "
    "ReportProgress takes three short fields:\n"
    "- evaluation_previous: did your last action work? what changed on the page?\n"
    "- working_memory: what have you learned about this site? what worked, what didn't?\n"
    "- next_goal: what specifically are you trying to do with the next action?\n"
    "After your first planning turn, keep all three fields TELEGRAPHIC, a few words each, "
    "not sentences (e.g. evaluation_previous: 'results loaded'; next_goal: 'click result 1'). "
    "Terse means fewer WORDS, never fewer FACTS: always keep the one detail the next step "
    "needs (the exact selector, index, or value). Each token you write is generated one at a "
    "time and is the main thing that slows a turn, so write the fewest that still carry the "
    "plan forward. Only write working_memory when you learn something NEW this turn; else 'none'.\n"
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

    "## Speed: fewer turns is the #1 driver\n"
    "Turns are slow model round-trips; tools are fast, so go fast by taking FEWER "
    "turns. Once you can see the page, emit the whole known sequence as ONE "
    "BrowserBatch instead of one tool per turn. Good batches: a form (type, type, "
    "click Send); a repeated action (5 swipes, 3 scrolls); a deterministic flow "
    "(type query, press Enter, click first result); or act-then-read by ending the "
    "batch with list_interactives, so click, wait, list_interactives is ONE turn "
    "not three. Max 5 sub-actions. The batch runs them in order and STOPS at the "
    "first that fails or if the URL changes, so order them safely (never a maybe-"
    "failing step before a must-do one). Don't batch when you must read the page "
    "MID-sequence to decide the next step, or when you're unsure what comes next.\n\n"

    "## Doing the SAME flow for many inputs? Use BrowserRepeatFlow\n"
    "If you're about to repeat the same mechanical flow for a list (read 10 "
    "profiles, search 8 terms, open each result): do the FIRST one normally to "
    "confirm the steps, then call BrowserRepeatFlow with the step template "
    "(use {{value}} where the input varies) and the remaining values. It runs them "
    "all in ONE turn at machine speed, no screenshots, and verifies each, "
    "reporting any that don't fit so you handle them yourself. For reading data, "
    "a 'replay_route' step (a captured API endpoint, see BrowserListRoutes) is far "
    "faster than navigating the UI. It refuses Send/Submit/Connect/Pay/Delete "
    "loops on purpose, do those one at a time so each is confirmed.\n\n"

    "## Avoid wasted cycles\n"
    "- Do NOT screenshot after every single action. Screenshot ONLY when you genuinely "
    "don't know the page state (start of task, after navigation, after a failure).\n"
    "- Don't BrowserWait if what you need is already on screen; just act (the wait is for "
    "content that hasn't loaded yet, not a reflex after every action).\n"
    "- When scrolling, stop as soon as BrowserScroll reports atTop/atBottom or a 0 delta; "
    "don't loop past the end.\n"
    "- Do NOT call BrowserGetElements on the entire body if you already know roughly "
    "where the target is. Scope it: `BrowserGetElements({selector: 'nav'})`.\n"
    "- Do NOT call the same failing tool twice with identical parameters. If selector "
    "X failed, try a DIFFERENT selector or a DIFFERENT strategy.\n"
    "- For repeated actions (swiping through profiles, going through inbox messages), "
    "use BrowserPressKey if available; it's an order of magnitude faster than DOM clicks.\n"
    "- To RE-READ data you already loaded once (search results, a list, a detail page), "
    "check BrowserListRoutes and use BrowserReplayRoute to fetch it straight from the "
    "site's API instead of re-navigating and re-scraping; it's much faster. This is for "
    "reading only, never for actions that change data (those go through the UI).\n\n"

    "## When you genuinely cannot proceed\n"
    "Use RequestHumanIntervention for:\n"
    "- Login walls (the user thinks they're logged in but the session expired)\n"
    "- Captchas, 2FA prompts, age verification gates\n"
    "- Anything genuinely ambiguous about user intent\n"
    "Don't use it for normal tool failures; try a different approach first.\n\n"

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
