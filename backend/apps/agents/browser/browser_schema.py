"""
Static schema + prompt blob for the browser sub-agent.

One big single-responsibility constant file: tool schema, action map, system
prompt, and the turn/report invariants. Exceeds the 300-LOC soft ceiling on
purpose because it is one cohesive data blob, not multiple responsibilities.
"""

# Two prompt levers that A/B-proved out and now ship unconditionally. THINK_SHORTER
# (no prose beside action tools; ReportProgress IS the thinking) cut per-turn output
# ~28% and roughly halved narration turns. MERGE_VERIFY (a confirmed `expect` is the
# proof, skip the re-check) drops a wasted round-trip at the end.
_THINK_SHORTER = (
    "Do NOT write a free-text sentence next to your action tools: your ReportProgress "
    "fields ARE your thinking, and a separate prose explanation just repeats them and slows "
    "the turn. Don't narrate to the user as you go either. When the task is done you finish by "
    "calling the Done tool (never by typing a sentence); every other turn is ReportProgress + "
    "tools, no prose.\n"
)

_MERGE_VERIFY = (
    "When that `expect` CONFIRMS (the result says 'Confirmed: ...'), that IS your "
    "verification: go STRAIGHT to calling Done. Do NOT spend an "
    "extra screenshot or read turn to re-check what the confirmation already proved, that "
    "is a wasted round-trip. Only take a separate verification step when `expect` came "
    "back 'NOT confirmed' or you forgot to pass one.\n"
)

MODEL_MAP = {
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-6",
    "haiku": "claude-haiku-4-5-20251001",
}

# The change an action should cause, declared by the agent and CONFIRMED after the
# action runs (success is observed, never assumed). A hit returns fast; a miss tells
# the agent it may not have worked instead of letting it claim a false success.
_EXPECT_DESC = {
    "type": "string",
    "description": (
        "Optional but recommended: LITERAL text that should be VISIBLE on the page "
        "after this action; an exact button label, a person's name, the exact text you "
        "just typed. Never a description of the change: 'message appears in box' is not "
        "page text, can never match, and will always come back NOT confirmed. It's "
        "checked right after, so you learn whether it actually worked. REQUIRED for "
        "anything you can't undo (Send/Submit/Pay/Post): set it to proof the action "
        "landed (for typing, the typed text itself)."
    ),
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
                        "OPTIONAL. Only when the previous action SURPRISED you (failed, "
                        "landed somewhere unexpected): say what happened and why, briefly. "
                        "Omit entirely when the attached page state already shows the outcome."
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
            "required": ["working_memory", "next_goal"],
        },
    },
    {
        "name": "Done",
        "description": (
            "Call this the moment the task is finished (or you've hit a wall you "
            "can't get past) to deliver your final reply to the user. This ends the "
            "run. Do NOT type a sentence to finish, always finish by calling Done."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": (
                        "What the user reads, so write it like a quick text to a friend: "
                        "what you did and the proof a person actually cares about (the name, "
                        "the time, what's now on screen). One or two plain sentences. Use ZERO "
                        "interface words, no 'button', 'box', 'textbox', 'composer', 'field', "
                        "'element', index numbers, or coordinates, and don't mechanically repeat "
                        "the task back. If you couldn't finish, say what's missing in that same "
                        "plain voice and set success to false."
                    ),
                },
                "success": {
                    "type": "boolean",
                    "description": (
                        "true if you accomplished what the user asked, false if you couldn't "
                        "(login wall, missing info, something blocked you). Default true."
                    ),
                },
            },
            "required": ["message"],
        },
    },
    {
        "name": "BrowserScreenshot",
        "description": (
            "Capture a screenshot of the browser page. Returns the screenshot as a "
            "base64-encoded PNG image. Use this to see what is currently displayed. "
            "Elements from your last BrowserListInteractives come back with numbered "
            "colored boxes drawn on them, the same numbers you click with, so you can "
            "go straight from what you see to BrowserClickIndex."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "annotate": {
                    "type": "boolean",
                    "description": (
                        "Default true. Pass false for a clean, unannotated shot, e.g. "
                        "when capturing proof of a completed action."
                    ),
                },
            },
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
        "name": "BrowserExtract",
        "description": (
            "Pull STRUCTURED data off the current page in one call: say what you "
            "want (and optionally the JSON shape) and a fast helper model reads "
            "the page text for you, returning just the JSON. Use this instead of "
            "BrowserGetText whenever you need specific fields (each result's name "
            "+ headline + URL, a listing's price/title/rating, table rows): the "
            "page's 15k chars stay out of your context, so it's faster and "
            "cheaper than reading it yourself. Read-only. If the data isn't on "
            "the page you get {\"not_found\": true}, never a guess."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "instruction": {
                    "type": "string",
                    "description": (
                        "What to extract, concretely (e.g. 'every search result: "
                        "full name, headline, profile URL')."
                    ),
                },
                "schema": {
                    "type": "object",
                    "description": "Optional JSON schema describing the exact output shape.",
                },
            },
            "required": ["instruction"],
        },
    },
    {
        "name": "BrowserSaveData",
        "description": (
            "Save a LARGE dataset you've assembled on the page straight to a file. "
            "Use this for 'every comment / all N results / the full list' once you've "
            "collected it into a page variable: trying to return hundreds of rows in your "
            "reply TRUNCATES, so you'd otherwise waste turns chunking it. Give a JS "
            "expression that returns the data as a string (almost always "
            "JSON.stringify(window.__yourVar)) plus a filename; the whole dataset is "
            "written to the workspace and you get back just the file path, not the data. "
            "It only writes your own workspace file (never the web). Put the returned path "
            "in your Done message so the user knows where it landed."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": (
                        "JS that returns the data as a string, e.g. "
                        "JSON.stringify(window.__rows) or a CSV string you build."
                    ),
                },
                "filename": {
                    "type": "string",
                    "description": (
                        "Plain data filename, e.g. results.json or comments.csv "
                        "(allowed: .json .ndjson .csv .tsv .txt .md)."
                    ),
                },
            },
            "required": ["expression", "filename"],
        },
    },
    {
        "name": "BrowserGetConsole",
        "description": (
            "Read the page's OWN recent JavaScript console warnings and errors "
            "(uncaught exceptions, failed resource loads like a 403/500, React "
            "errors). Use this when an action isn't working and the page looks "
            "fine: it tells you WHY the page is broken (an API call failed, the "
            "app crashed) so you fix the real cause instead of retrying blindly. "
            "Read-only; returns nothing if the page logged no warnings or errors."
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
                "expect": _EXPECT_DESC,
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
            "BrowserGetElements (which uses CSS selectors). Numbers are STABLE "
            "across looks (same number = same element as your previous list, so "
            "you can act on a remembered index without re-listing if the page "
            "hasn't changed). When several rows share a label, each carries "
            "ctx=\"...\" naming the card/section it sits in, so pick the row whose "
            "ctx matches your target (the right person's \"Message\" button). "
            "NOTE: every mutating action's result already ends with '[page state "
            "after action]', a fresh copy of this list, so right after acting you "
            "do NOT need this; call it only to re-orient or when the attached "
            "list was truncated."
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
            "SOLO click, reserved for two cases: (1) the final IRREVERSIBLE step "
            "(Send/Submit/Pay/Post), always alone with `expect` proof, and (2) "
            "filling a text box via `text` (focused directly by node, so it works "
            "inside messaging/compose overlays where coordinate clicks miss). "
            "Routine clicks belong inside BrowserBatch as click_index sub-actions. "
            "Uses native OS-level mouse events (event.isTrusted=true) so it works "
            "on sites that filter synthetic JS events. If the click returns "
            "'index no longer valid', the page changed; re-list and retry."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "integer",
                    "description": "The numeric index from BrowserListInteractives (1-based).",
                },
                "text": {
                    "type": "string",
                    "description": (
                        "Optional. If the index is a text box, focus it and type this "
                        "whole string in one call (no character-by-character). Use this "
                        "to fill a compose/message box reliably."
                    ),
                },
                "expect": _EXPECT_DESC,
            },
            "required": ["index"],
        },
    },
    {
        "name": "BrowserBatch",
        "description": (
            "Your standard way to ACT on the page. Every mutation (navigate, "
            "click, type, press, scroll) is a sub-action in this array, 1-5 per "
            "call; an array of one is fine when that is genuinely all you know. "
            "Each sub-action executes in order with the URL captured before/after. "
            "If the URL changes mid-batch (the page navigated), the rest is "
            "aborted and you get a partial result plus fresh state, so a "
            "conservative batch costs nothing.\n\n"
            "Sub-action types and their params:\n"
            "- click_index: { index: int }\n"
            "- press_key: { key: str }\n"
            "- click_point: { xPercent: number, yPercent: number, hold_ms?: int } "
            "(tap a screen point; for canvas apps/games)\n"
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
                                "enum": ["click_index", "press_key", "click_point", "type", "wait", "scroll", "navigate", "click", "list_interactives"],
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
        "name": "BrowserClickPoint",
        "description": (
            "Tap/click at a point on the screen using a real native mouse event, "
            "WITHOUT needing a DOM element. This is the way to operate a <canvas> "
            "app or game (the kind with no clickable HTML elements): you click a "
            "spot the way a person does. Give the position as a PERCENT of the view "
            "(xPercent/yPercent, 0-100, with 0,0 = top-left and 50,50 = center), "
            "read off the screenshot. Optional hold_ms presses and holds (e.g. a "
            "charge-up or a platformer jump). For element-based pages prefer "
            "BrowserClickIndex; use this when there is nothing in the element list "
            "to click."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "xPercent": {
                    "type": "number",
                    "description": "Horizontal position as a percent of view width (0=left, 100=right).",
                },
                "yPercent": {
                    "type": "number",
                    "description": "Vertical position as a percent of view height (0=top, 100=bottom).",
                },
                "hold_ms": {
                    "type": "number",
                    "description": "Optional. Milliseconds to hold the button down before releasing (default 0 = a tap). Max 5000.",
                },
                "button": {
                    "type": "string",
                    "enum": ["left", "right", "middle"],
                    "description": "Mouse button; defaults to left.",
                },
            },
            "required": ["xPercent", "yPercent"],
        },
    },
    {
        "name": "BrowserWait",
        "description": (
            "Wait for the page to be READY after navigation or an action. This is SMART: "
            "it returns as soon as the page settles visually (its DOM stops changing), so "
            "the duration is just an upper bound, not a fixed sleep, pass a generous cap "
            "(e.g. 4000) without worrying about wasted time. Best of all, pass `until` with "
            "the thing you expect to appear (a button label, result text, the compose box) "
            "and it returns the INSTANT that shows up, so you wait for what you actually "
            "need instead of guessing. Min 100, max 10000."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "milliseconds": {
                    "type": "number",
                    "description": "Upper-bound wait in milliseconds. Defaults to 1000.",
                },
                "until": {
                    "type": "string",
                    "description": (
                        "Optional. A specific button label, visible text, or CSS selector "
                        "you expect to appear (e.g. the person's name you searched, a "
                        "placeholder like 'Write a message', or 'button[type=submit]'). The "
                        "wait ends the moment it's present and visible. Be specific, not a "
                        "generic word like 'Message'."
                    ),
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

# Schema-forced batching: the model ignored every prompt-level batching
# invitation (0 adoptions across 8 measured runs), so the single-step mutating
# tools are not offered to it at all; acting means a BrowserBatch array, and
# the one deliberate solo path is BrowserClickIndex (irreversible step with
# expect, or a text-box fill). Executors and replay still support everything.
_SOLO_MUTATORS_HIDDEN = {"BrowserNavigate", "BrowserClick", "BrowserType", "BrowserScroll", "BrowserPressKey", "BrowserClickPoint"}
MODEL_VISIBLE_TOOLS = [t for t in BROWSER_TOOLS_SCHEMA if t["name"] not in _SOLO_MUTATORS_HIDDEN]

ACTION_MAP = {
    "BrowserScreenshot": "screenshot",
    "BrowserGetText": "get_text",
    "BrowserGetConsole": "get_console",
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
    "BrowserClickPoint": "click_point",
    "BrowserBatch": "batch",
    "BrowserDetectWebMCP": "detect_webmcp",
    "BrowserListRoutes": "list_routes",
    "BrowserReplayRoute": "replay_route",
    # Internal replay primitive (skill replay calls it directly; not in the
    # LLM-facing schema). Re-resolves a click target by role+name.
    "BrowserClickByName": "click_by_name",
}

# --- App agent: driving an OpenSwarm-built app via its native bridge ---------
# Apps expose window.OPENSWARM_APP = { describe(), getState(), invoke(name,args) }.
# The agent reads structure/state and acts through that bridge in single
# executeJavaScript round-trips, no screenshots or accessibility tree. These
# three tools are translated to BrowserEvaluate in execute_browser_tool, so they
# need no frontend command-handler changes.
APP_TOOLS_SCHEMA = [
    {
        "name": "AppDescribe",
        "description": (
            "Read the app's rules and CURRENT list of actions, straight from the "
            "app itself (window.OPENSWARM_APP.describe()). Returns "
            "{rules, controls, __rev}: rules is what the app is and its objective, "
            "controls is an array of {name, args, description, keys}, and __rev is "
            "a revision number. (Older apps may return a bare array of controls.) "
            "These are ALREADY front-loaded into your first message, so you rarely "
            "need to call this. The app's controls are DYNAMIC: call this again "
            "ONLY when AppGetState reports a changed __rev (e.g. after an AppInvoke "
            "added or removed actions). Returns null if the app exposes no bridge "
            "(then fall back to BrowserListInteractives/BrowserScreenshot)."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "AppGetState",
        "description": (
            "Read a small JSON snapshot of the app's current state "
            "(window.OPENSWARM_APP.getState()). Use it to check what's on screen "
            "and to verify an action landed. The snapshot includes __rev, the "
            "controls revision: if it differs from the __rev you were given, the "
            "controls changed, so call AppDescribe to refresh them. Returns null "
            "if the bridge is absent."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "AppInvoke",
        "description": (
            "Perform one app action by name with arguments "
            "(window.OPENSWARM_APP.invoke(name, args)). The name MUST be one that "
            "AppDescribe just returned; never invent or modify actions, only invoke "
            "the ones the app exposes. Returns the action's result, or an "
            "{__error__} if it threw. After invoking, re-AppDescribe if the action "
            "may have changed which controls exist."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Action name from AppDescribe."},
                "args": {
                    "type": "object",
                    "description": "Arguments object for the action; {} if none.",
                },
            },
            "required": ["name"],
        },
    },
]

# Bridge tool names -> the JS the app exposes. execute_browser_tool maps these to
# a BrowserEvaluate. Each expression returns a JSON string (so it round-trips as
# text) and never throws (errors are returned as JSON).
APP_BRIDGE_TOOLS = {"AppDescribe", "AppGetState", "AppInvoke"}

# Lean toolset for app mode: bridge tools first, then a UI-driving fallback for
# apps that don't expose the bridge. Built by name-selecting the shared defs so
# their schemas stay in one place.
_APP_FALLBACK_TOOL_NAMES = [
    "ReportProgress", "Done",
    "BrowserScreenshot", "BrowserGetText",
    "BrowserListInteractives", "BrowserClickIndex", "BrowserBatch",
    # Human-style native input for apps with no clickable DOM (canvas games):
    # press real keys and tap real screen points the way a person plays.
    "BrowserPressKey", "BrowserClickPoint",
]
_app_fallback_tools = [t for t in BROWSER_TOOLS_SCHEMA if t["name"] in _APP_FALLBACK_TOOL_NAMES]
# ReportProgress + Done lead, then the bridge tools, then UI fallback.
APP_VISIBLE_TOOLS = (
    [t for t in _app_fallback_tools if t["name"] in ("ReportProgress", "Done")]
    + APP_TOOLS_SCHEMA
    + [t for t in _app_fallback_tools if t["name"] not in ("ReportProgress", "Done")]
)

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

    "## Jump straight to deep URLs\n"
    "The fastest navigation is a URL you construct yourself. Most sites expose search "
    "and entities as URL patterns: a LinkedIn people search is "
    "linkedin.com/search/results/people/?keywords=NAME, a Google search is "
    "google.com/search?q=..., a YouTube search is youtube.com/results?search_query=..., "
    "an Amazon search is amazon.com/s?k=.... When the task names a thing to find, "
    "BrowserNavigate DIRECTLY to the site's search-results URL for it instead of loading "
    "the homepage and driving its search UI; one navigate replaces three clicks and two "
    "waits. Fall back to the UI only when you don't know the site's URL pattern.\n\n"

    "## Required output structure: ReportProgress before every action\n"
    "Before ANY action tool (BrowserBatch, BrowserClickIndex, BrowserEvaluate), "
    "you MUST call the ReportProgress tool in the SAME turn. "
    "ReportProgress takes these short fields:\n"
    "- evaluation_previous (OPTIONAL): include ONLY when the last action surprised you "
    "(failed, wrong page); when the attached page state already tells the story, omit it.\n"
    "- working_memory: what have you learned about this site? what worked, what didn't?\n"
    "- next_goal: what specifically are you trying to do with the next action?\n"
    "After your first planning turn, keep every field TELEGRAPHIC, a few words each, "
    "not sentences (e.g. next_goal: 'click result 1'). "
    "Terse means fewer WORDS, never fewer FACTS: always keep the one detail the next step "
    "needs (the exact selector, index, or value). Each token you write is generated one at a "
    "time and is the main thing that slows a turn, so write the fewest that still carry the "
    "plan forward. Only write working_memory when you learn something NEW this turn; else 'none'.\n"
    + _THINK_SHORTER +
    "Emit ReportProgress and your action tool(s) together in the same response. "
    "If you skip ReportProgress, your action tools will be REJECTED with an error "
    "and you will have to retry. This is not optional. Read-only tools "
    "(BrowserScreenshot, BrowserGetText, BrowserGetConsole, BrowserGetElements, BrowserWait) do not "
    "require ReportProgress.\n\n"

    "## Act and confirm: trust only what you observe\n"
    "Success is OBSERVED, never assumed. On any action that changes the page (click, "
    "type, navigate), add `expect`: the change it should cause (a label, text, or the "
    "element you expect to see). It's confirmed right after, a hit comes back fast and "
    "you move on; a 'NOT confirmed' means it may not have worked, so check the page "
    "instead of pressing on. For anything you CANNOT undo (Send, Submit, Pay, Post): "
    "first make sure the goal isn't already done (e.g. your message isn't already the "
    "last one in the thread), pass `expect` set to proof it landed, and NEVER fire it a "
    "second time unless you have verified the first did NOT go through. This is how you "
    "avoid both ghost-successes and double-sends.\n"
    "When you arrive (or wake) with the target's message THREAD or composer ALREADY OPEN, "
    "that IS your thread, commit to it. The open thread's header name (and your own earlier "
    "messages to that person sitting in it) ARE the recipient proof; do NOT navigate away to "
    "open their profile or re-search 'just to be sure', that round-trips for nothing and can "
    "even land you on the wrong surface. The plan from an open composer is fixed and short: "
    "type the message, click Send, then verify ONCE. Execute it; do not re-derive it, re-open "
    "anything, or re-confirm with extra screenshots/DOM/JS probes what the open thread already "
    "shows. That re-verification is the single biggest waste of turns.\n"
    "If you already saw the Send button (or Submit/Post) at an index, REMEMBER that "
    "number: typing into the composer does NOT move it, so after you type, click that "
    "same remembered index directly. Do NOT decide it vanished and hunt for it with JS, "
    "inspections, or screenshots just because the post-type state only re-lists the rows "
    "that CHANGED, the unchanged Send is still there at its number. If clicking it comes "
    "back 'NOT confirmed', only THEN re-list to find where it moved.\n"
    + _MERGE_VERIFY + "\n"

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
    "1. **Keyboard shortcuts via press_key sub-actions**; fastest and most reliable on sites "
    "that support them (Tinder swipes, Gmail navigation, Slack message jump, etc.). "
    "Always check if the site shows keyboard hints in the UI before falling back to clicks. "
    "BrowserPressKey sends real native events that pass the `event.isTrusted` check, so "
    "it works where dispatchEvent in BrowserEvaluate silently fails.\n"
    "2. **Accessibility tree via BrowserListInteractives + BrowserClickIndex**; the "
    "accessibility tree sees roles and names that the raw DOM doesn't, even on sites "
    "like Tinder, Instagram, and TikTok that use unlabeled <div>s with click handlers. "
    "Call BrowserListInteractives to get a numbered list (`[1]<button \"Like\">`, "
    "`[2]<link \"Settings\">`), then BrowserClickIndex with the number. A `*` after the "
    "number marks an element that appeared since your previous look; right after a click "
    "that opened a dialog or menu, the `*` rows are almost always the ones to act on. "
    "Numbers are STABLE between looks: the same number always means the same element, so "
    "when you already know the index from your previous list and the page hasn't changed, "
    "click it directly, don't re-list. When several rows share the same label (eight "
    "\"Message\" buttons in search results), each carries ctx=\"...\" naming the card or "
    "section it belongs to; match ctx against your target instead of guessing or clicking "
    "into profiles to disambiguate. "
    "The click uses "
    "native OS-level mouse events so it works where DOM .click() doesn't. THIS IS YOUR "
    "GO-TO STRATEGY for unlabeled or hostile sites; try this BEFORE BrowserGetElements. "
    "To FILL a text box (a `<textbox>` like a message/compose field, including ones inside "
    "a messaging overlay where clicks miss), call BrowserClickIndex on it with a `text` arg: "
    "it focuses the box by node and types the whole string in ONE call, no coordinates, no "
    "character-by-character. Then send with a press_key 'Enter' sub-action or the Send button.\n"
    "3. **Semantic CSS selectors**; `button[aria-label='X']`, `[role='button']`, "
    "`a[href*='...']`. Try these via BrowserGetElements + a click sub-action when the site "
    "actually has semantic HTML.\n"
    "4. **Text-based JS query**; when both of the above fail, use BrowserEvaluate to "
    "find elements by visible text: `Array.from(document.querySelectorAll('*')).find(el => el.textContent.trim() === 'Like')`.\n"
    "5. **Coordinate-based fallback**; last resort: take a screenshot, identify the "
    "button visually, then click by approximate coords.\n\n"

    "## Speed: fewer turns is the #1 driver\n"
    "Turns are slow model round-trips; tools are fast. You act through "
    "BrowserBatch: an array of 1-5 actions per call (navigate, click_index, "
    "type, press_key, scroll), executed in order with settle between steps. "
    "When the state you are reading already names your next 2-3 targets, put "
    "them in ONE array; an array of one is fine when the next step genuinely "
    "depends on something you haven't seen. Good arrays: a deterministic flow "
    "(type query, press Enter, click first result); a repeated action (5 "
    "swipes); act-then-read by ending with list_interactives so click, wait, "
    "read is ONE turn not three. The batch STOPS at the first failing or URL-"
    "changing step and you continue from the fresh attached state, so a "
    "conservative array costs nothing; order steps safely (never a maybe-"
    "failing step before a must-do one). TWO solo exceptions, both via "
    "BrowserClickIndex: the final irreversible step (Send/Submit/Pay/Post) "
    "always alone with `expect` proof, and text-box fills via its `text` "
    "param.\n\n"

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
    "- NEVER call BrowserWait or BrowserListInteractives right after an action. Every "
    "mutating action (every batch and every solo click) already settles on its "
    "own (waits for network/DOM quiet) and its result ends with '[page state after "
    "action]': a fresh numbered element list. To keep results lean it may show ONLY the "
    "rows that changed plus a count of unchanged ones; unchanged rows keep their numbers, "
    "so act on remembered indices freely. Act straight from that state; waiting or "
    "re-listing after an action is a wasted turn. Reserve BrowserWait for content you "
    "KNOW arrives late (pass `until` with the exact thing you expect), and "
    "BrowserListInteractives for re-orienting or when the attached list was truncated.\n"
    "- When scrolling, stop as soon as a scroll sub-action reports atTop/atBottom or a 0 delta; "
    "don't loop past the end.\n"
    "- Do NOT call BrowserGetElements on the entire body if you already know roughly "
    "where the target is. Scope it: `BrowserGetElements({selector: 'nav'})`.\n"
    "- Do NOT call the same failing tool twice with identical parameters. If selector "
    "X failed, try a DIFFERENT selector or a DIFFERENT strategy.\n"
    "- For repeated actions (swiping through profiles, going through inbox messages), "
    "use press_key sub-actions if available; an order of magnitude faster than DOM clicks.\n"
    "- To RE-READ data you already loaded once (search results, a list, a detail page), "
    "check BrowserListRoutes and use BrowserReplayRoute to fetch it straight from the "
    "site's API instead of re-navigating and re-scraping; it's much faster. This is for "
    "reading only, never for actions that change data (those go through the UI).\n"
    "- To pull SPECIFIC FIELDS off a page (names + links from results, prices, table "
    "rows), call BrowserExtract with what you want; a helper model reads the page and "
    "hands you just the JSON. One call replaces BrowserGetText plus you reading 15k "
    "chars, so prefer it whenever you know the fields you're after.\n"
    "- For ANY 'find me / list / get all / top N / most-viewed' gathering task, "
    "BrowserExtract IS your tool: state the fields and let the helper read the rendered "
    "page. Do NOT hand-roll CSS/DOM selectors in BrowserEvaluate to scrape a list, modern "
    "sites (YouTube, LinkedIn, Amazon) obfuscate and lazy-render class names, so selector "
    "scraping burns turns and silently returns the wrong nodes. If one BrowserEvaluate read "
    "comes back empty or shaped wrong, STOP, that is your signal to switch to BrowserExtract, "
    "not to debug another selector. The answer must end up IN your Done message, so gather it "
    "for real; never report done on a gather task you couldn't actually read.\n"
    "- Getting ALL N across MANY pages? Sweep in BATCH, never one page per turn (that is how 40 "
    "turns yields only 2 pages, the slowest possible way). Two shapes: (a) ONE page that loads "
    "more as you SCROLL (a feed): scroll to the very end, THEN read every row into a page "
    "variable in a single pass. (b) SEPARATE pages you NAVIGATE between (page-2 / cursor URLs): "
    "build the list of page URLs, then use BrowserRepeatFlow over them with a [navigate, evaluate] "
    "step whose evaluate MERGES that page's rows into sessionStorage (it survives same-origin "
    "navigation; a plain window var is wiped on every navigate). Either way you finish with the "
    "whole set in ONE place. Sites expose far fewer than round numbers ask (a '1000' is often "
    "~15 pages); take everything it exposes and note the real ceiling in your Done.\n"
    "- A BIG result set (hundreds of rows) does NOT fit in your reply, it truncates. Do NOT "
    "chunk it back through your messages 100 at a time. Once it's gathered into a page variable, "
    "call BrowserSaveData('JSON.stringify(window.__rows)', 'results.json') ONCE: it writes the "
    "whole thing to a file and hands you the path. Then Done, telling the user that path. That "
    "is one step instead of a dozen.\n\n"

    "## When you genuinely cannot proceed\n"
    "Use RequestHumanIntervention for:\n"
    "- Login walls (the user thinks they're logged in but the session expired)\n"
    "- Captchas, 2FA prompts, age verification gates\n"
    "- Anything genuinely ambiguous about user intent\n"
    "Don't use it for normal tool failures; try a different approach first.\n\n"

    "Complete the task autonomously. When you're finished, end the run by calling the Done "
    "tool, never by typing a sentence. Put your reply to the user in Done's `message`, "
    "written like a normal chat reply: what got done plus the human proof (the name, the "
    "time, what's now on screen), in one or two plain sentences with zero interface words. "
    "Set `success` false if you couldn't finish. For irreversible actions, only report "
    "success with real proof you actually observed (the name and where/when you saw it), "
    "just phrased for a person, not for a machine."
)

MAX_TURNS = 40

# App mode: drive an OpenSwarm-built app through its native bridge. This is the
# global "how to operate an app" guidance (decision: one global doc, not per-app;
# per-app specifics come live from AppDescribe). Deliberately short, the bridge
# does the heavy lifting and future models need less hand-holding.
APP_SYSTEM_PROMPT = (
    "You operate an OpenSwarm-built app (a small web app the user created, e.g. a "
    "graphing tool or a form). The app is ALREADY open in front of you; do not "
    "navigate anywhere.\n\n"

    "## How you see and act: the app's own bridge (this is the fast path)\n"
    "The app exposes a native bridge, window.OPENSWARM_APP, with three calls you "
    "reach through tools:\n"
    "- AppDescribe -> {rules, controls, __rev}: the app's objective and its "
    "current actions {name, args, description, keys}.\n"
    "- AppGetState -> a small JSON snapshot of what's on screen (includes __rev).\n"
    "- AppInvoke(name, args) -> perform one action.\n"
    "The app's rules and controls have ALREADY been read for you and placed in "
    "your first message, so you can start invoking actions immediately; you do "
    "NOT need screenshots, the DOM, or the accessibility tree, and you usually do "
    "NOT need to call AppDescribe at all.\n"
    "Only ever call actions that AppDescribe actually returned. You operate the app, "
    "you do NOT change it: never invent action names, and never try to add, remove, "
    "or redefine the app's available actions or edit its code. If what the user wants "
    "isn't reachable through the exposed actions, say so in Done.\n\n"

    "## Controls are DYNAMIC, but you only re-read on a __rev change\n"
    "Actions can change as you interact (the app adds and removes controls). The "
    "front-loaded controls came with a __rev number. Use AppGetState to verify "
    "outcomes; if its __rev differs from the one you have, the controls changed, "
    "so call AppDescribe ONCE to refresh them. As long as __rev is unchanged, "
    "trust the controls you already have and do not re-describe.\n\n"

    "## Fast/real-time games: turn on autopilot, then SUPERVISE\n"
    "If the controls include `__autopilot__`, the app can play itself at frame "
    "rate (twitch games like Flappy or Doodle Jump are impossible to play by "
    "pressing a key per screenshot; the network round-trip is far slower than the "
    "game). Do NOT try to react frame by frame. Instead run two loops:\n"
    "- Start it: AppInvoke('__autopilot__', {on:true}). The app's reflex now "
    "handles the per-frame twitch.\n"
    "- Supervise on a SLOW cadence (every few seconds): AppGetState and check "
    "progressRate / alive / score. Healthy play = cheap state polls; do NOT "
    "screenshot every turn.\n"
    "- Escalate only when stuck: if progressRate stays ~0 while alive across a "
    "couple of polls, take ONE BrowserScreenshot to see what the one-frame "
    "heuristic cannot (a platform off to the side, a hazard), then STEER by "
    "invoking __autopilot__ again with this app's steering knobs (named in the "
    "__autopilot__ control description / the app's rules), e.g. {bias:-30} or "
    "{aggressiveness:1.5}. The running reflex obeys at frame rate; you never "
    "stop it.\n"
    "- Stop when the goal is met (or to hand back control): "
    "AppInvoke('__autopilot__', {on:false}).\n\n"

    "## If there is no bridge: operate it like a person\n"
    "If AppDescribe (or AppGetState) returns null, this app exposes no bridge, so "
    "drive it directly the way a human would, by looking at the screen and using "
    "the keyboard and mouse:\n"
    "- SEE with BrowserScreenshot (your main sense here); read on-screen text/score "
    "from it. BrowserGetText helps for text-heavy apps.\n"
    "- For a normal HTML app (buttons, inputs, forms): BrowserListInteractives to "
    "find controls, then BrowserClickIndex / BrowserBatch to act.\n"
    "- For a CANVAS app or GAME (no clickable elements in the list): play it with "
    "native input. BrowserPressKey for keyboard (e.g. 'Space' to flap, "
    "'ArrowLeft'/'ArrowRight' to move, 'Enter' to start) and BrowserClickPoint to "
    "tap a spot, giving xPercent/yPercent read off the screenshot (50,50 = center). "
    "These are REAL OS-level events, identical to you pressing a key or clicking, so "
    "the game responds exactly as it does for a person. Take a screenshot to "
    "confirm what changed, then act again.\n"
    "- Need fast repeated input (rapid flaps/taps)? Put several BrowserPressKey or "
    "BrowserClickPoint steps in one BrowserBatch so they fire in a single turn.\n"
    "If you truly cannot operate it, say so plainly in Done with success=false.\n\n"

    "## ReportProgress before acting\n"
    "Before any AppInvoke (or UI action), call ReportProgress in the SAME turn with "
    "a telegraphic next_goal and working_memory. AppDescribe and AppGetState are "
    "reads and do not require it.\n\n"

    "## Speed\n"
    "Fewer model turns is the #1 driver. Once AppDescribe tells you the actions, "
    "fire the AppInvokes you need; don't re-describe between every step unless the "
    "action list could have changed. Keep your notes a few words each.\n\n"

    "When finished, end by calling Done; put a plain one or two sentence reply in "
    "its message (what you did and the proof, e.g. what's now graphed), zero "
    "interface words. Set success=false if you couldn't finish."
)

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
    "BrowserClickPoint",  # app mode: tap a canvas/game at a screen point
    "BrowserBatch",  # Phase 4
    "AppInvoke",  # app mode: invoking an app action mutates state
}
