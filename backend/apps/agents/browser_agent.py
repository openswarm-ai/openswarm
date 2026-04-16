"""
Browser sub-agent runner.

Provides a lightweight Anthropic API tool-use loop that drives browser
interactions directly through ws_manager (no MCP subprocess needed).
Sub-agents appear as visible AgentSession cards on the dashboard.
"""

import asyncio
import json
import logging
import time
from datetime import datetime
from uuid import uuid4

import anthropic

from backend.apps.agents.models import AgentSession, ApprovalRequest, Message
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.tools_lib.tools_lib import load_builtin_permissions

logger = logging.getLogger(__name__)

MODEL_MAP = {
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-6",
    "haiku": "claude-haiku-4-5-20251001",
}

# Cache of conversation history per browser_id so successive BrowserAgent
# calls on the same browser can resume rather than restart from scratch.
# Without this every "swipe right" / "swipe left" call has to take a new
# screenshot and re-orient itself, costing 30-60s per action.
_browser_history: dict[str, list[dict]] = {}
# Cap history to prevent unbounded growth on long-lived browsers.
_MAX_HISTORY_MESSAGES = 30


def clear_browser_history(browser_id: str) -> None:
    """Drop cached conversation history for a browser (e.g. when it's closed)."""
    _browser_history.pop(browser_id, None)


# ---------------------------------------------------------------------------
# Loop detection
#
# Tracks recent state-mutating tool calls in a sliding window. If the model
# repeats the same (tool, input) with the same result several times, we
# inject an is_error message in the next tool_result to force a strategy
# change. This prevents the model from burning the entire turn budget on
# a failing approach.
# ---------------------------------------------------------------------------

# Tools that are read-only / idempotent and should NOT count toward loop
# detection. Repeating these is normal (scrolling through a feed, taking
# successive screenshots, polling for an element to appear).
_LOOP_DETECTION_EXCLUDED_TOOLS = {
    "BrowserScreenshot",
    "BrowserGetText",
    "BrowserGetElements",
    "BrowserListInteractives",  # Phase 3
    "BrowserWait",
    "ReportProgress",  # Phase 2
    "RequestHumanIntervention",
}

_LOOP_WINDOW_SIZE = 5
_LOOP_REPEAT_THRESHOLD = 3
_LOOP_HARD_CAP = 5


def _hash_tool_call(tool_name: str, tool_input: dict, result: dict) -> tuple[str, str, str]:
    """Build a stable hash key for a tool call, including its result.

    Including the result hash means that legitimate progress (same input,
    different output — e.g. BrowserScroll on a long feed) does NOT count
    as a loop. Only same-input + same-output is treated as stuck.
    """
    try:
        input_key = json.dumps(tool_input, sort_keys=True, default=str)
    except Exception:
        input_key = repr(tool_input)
    try:
        # Truncate the result hash to avoid huge image blobs in the key
        result_key = json.dumps(result, sort_keys=True, default=str)[:300]
    except Exception:
        result_key = repr(result)[:300]
    return (tool_name, input_key, result_key)


def _detect_loop(
    recent_calls: list[tuple[str, str, str]],
    new_call: tuple[str, str, str],
) -> bool:
    """Return True if `new_call` constitutes a loop given recent history.

    A loop is when the same (tool, input, result) has appeared at least
    `_LOOP_REPEAT_THRESHOLD` times within the last `_LOOP_WINDOW_SIZE`
    state-mutating calls (the new call counts as one of those occurrences).
    """
    if new_call[0] in _LOOP_DETECTION_EXCLUDED_TOOLS:
        return False
    window = recent_calls[-(_LOOP_WINDOW_SIZE - 1):] + [new_call]
    matches = sum(1 for c in window if c == new_call)
    return matches >= _LOOP_REPEAT_THRESHOLD


_LOOP_WARNING_TEXT = (
    "LOOP DETECTED: You have called this tool with these exact parameters and "
    "gotten the same result {count} times in a row. STOP retrying this approach "
    "— it is not working. Try a fundamentally different strategy: "
    "(1) check the page state with BrowserScreenshot or BrowserGetText, "
    "(2) try a different selector or a different tool, "
    "(3) use BrowserPressKey for keyboard shortcuts if the site supports them, "
    "or (4) call RequestHumanIntervention if you genuinely cannot proceed."
)


def _validate_message_pairing(messages: list[dict]) -> bool:
    """Verify every tool_result references a tool_use_id from a prior assistant
    message in the same list. Returns False if there's an orphan, which means
    the cached history would 400 if sent to the API.

    This is the last line of defense against cache corruption — if it ever
    returns False on a resume, we drop the cache and start fresh rather than
    crash on the next API call.
    """
    declared_tool_use_ids: set[str] = set()
    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")
        if role == "assistant" and isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tu_id = block.get("id")
                    if tu_id:
                        declared_tool_use_ids.add(tu_id)
        elif role == "user" and isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    tr_id = block.get("tool_use_id")
                    if tr_id and tr_id not in declared_tool_use_ids:
                        return False
    return True


def _is_fresh_user_message(msg: dict) -> bool:
    """A 'fresh' user message starts a new turn — string content or a list
    that contains no tool_result blocks. These are the only safe cut points
    because they don't reference any prior assistant tool_use blocks."""
    if msg.get("role") != "user":
        return False
    content = msg.get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list) and not any(
        isinstance(c, dict) and c.get("type") == "tool_result" for c in content
    ):
        return True
    return False


def _summarize_messages(messages: list[dict]) -> str:
    """Build a programmatic summary of older browser-agent messages.

    Extracts the original user task, a count of tool calls by name with their
    key parameters, the last few ReportProgress brain states, and the most
    recent assistant text. No LLM call required — this is purely structural
    extraction from the existing message history.
    """
    if not messages:
        return ""

    # Find the original user task (first user-text message)
    initial_task = ""
    for msg in messages:
        if msg.get("role") == "user":
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                initial_task = content.strip()[:300]
                break

    # Count tool calls by name with key params
    tool_call_summary: dict[str, list[str]] = {}
    brain_states: list[str] = []
    last_assistant_text = ""

    for msg in messages:
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "tool_use":
                name = block.get("name", "unknown")
                inp = block.get("input") or {}
                if name == "ReportProgress":
                    # Capture the brain state for inline summary
                    brain_states.append(
                        f"  • {inp.get('next_goal', '')[:120]}"
                    )
                    continue
                # Compact one-line description with key params
                key_param = ""
                for k in ("index", "key", "url", "selector", "direction", "text"):
                    if k in inp:
                        v = str(inp[k])[:40]
                        key_param = f"{k}={v}"
                        break
                desc = f"{name}({key_param})" if key_param else name
                tool_call_summary.setdefault(name, []).append(desc)
            elif btype == "text":
                txt = block.get("text", "").strip()
                if txt:
                    last_assistant_text = txt

    # Build the summary text
    parts = ["[Summary of earlier browser-agent activity]"]
    if initial_task:
        parts.append(f'Original task: "{initial_task}"')
    if tool_call_summary:
        total = sum(len(v) for v in tool_call_summary.values())
        parts.append(f"Actions taken ({total} total):")
        # Show count + a couple of representative examples per tool
        for name in sorted(tool_call_summary.keys()):
            calls = tool_call_summary[name]
            count = len(calls)
            sample = calls[-1]  # most recent example
            if count == 1:
                parts.append(f"  - {sample}")
            else:
                parts.append(f"  - {sample} (×{count})")
    if brain_states:
        parts.append("Recent intents:")
        parts.extend(brain_states[-5:])  # last 5 brain states
    if last_assistant_text:
        snippet = last_assistant_text[:400]
        parts.append(f"Last update from assistant: {snippet}")
    parts.append(
        "(Earlier turn-by-turn details have been compacted to keep the "
        "context window manageable. Continue from where you left off.)"
    )
    return "\n".join(parts)


def _trim_history_by_turns(messages: list[dict], max_messages: int) -> list[dict]:
    """Compact message history when it exceeds max_messages.

    The Anthropic API requires every `tool_result` block to reference a
    `tool_use_id` from a previous assistant message. Naive slicing can drop
    a tool_use while keeping its tool_result, causing 400 errors. This
    function avoids that by:

    1. Walking forward to find a clean turn boundary (a fresh user-text
       message that starts a new turn — no tool_result content).
    2. Summarizing everything BEFORE that boundary into a single user-text
       message and prepending it to the kept tail.
    3. If no clean boundary exists at all, returning the original history
       unchanged. Better to temporarily exceed the cap than to corrupt the
       conversation and 400 every subsequent request.

    The summary is built programmatically (no LLM call) from the message
    structure: original task, tool call counts, recent ReportProgress brain
    states, and last assistant text.
    """
    if len(messages) <= max_messages:
        return list(messages)

    target_tail_size = max_messages - 1  # leave room for the summary message
    cut_index: int | None = None

    # First pass: walk forward looking for the EARLIEST clean cut point that
    # gets us under the cap. This preserves the most recent detail.
    for i in range(1, len(messages)):
        if not _is_fresh_user_message(messages[i]):
            continue
        if len(messages) - i <= target_tail_size:
            cut_index = i
            break

    # Second pass: if no cut point gets us under the cap (e.g. the current
    # turn alone is bigger than max_messages), use the LATEST clean cut point
    # available. The tail will still exceed the cap, but it's the smallest
    # safe history we can produce — and any compaction is better than none.
    if cut_index is None:
        for i in range(len(messages) - 1, 0, -1):
            if _is_fresh_user_message(messages[i]):
                cut_index = i
                break

    if cut_index is None:
        # No clean cut anywhere in the history. Return original — better to
        # exceed the cap than to corrupt the conversation.
        return list(messages)

    # Compact: summarize messages[0..cut_index-1], prepend as a single
    # user-text message, then keep messages[cut_index..end] verbatim.
    summary_text = _summarize_messages(messages[:cut_index])
    summary_msg = {"role": "user", "content": summary_text}
    return [summary_msg] + list(messages[cut_index:])

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
                        "Short notes about what you've learned about this site so far — "
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
            "uses unlabeled <div>s — the accessibility tree sees roles and names "
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
            "returns 'index no longer valid', the page changed — re-list and retry."
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
            "have a known sequence — typing then pressing Enter, swiping multiple "
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
            "ignored — sites like Tinder, Slack, Notion, Gmail listen for trusted key "
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
            "programmatically — captchas, login prompts, cookie consent walls, "
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
                        "15 words. Example: 'Login required — please sign in to X/Twitter.'"
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
    "website the user is signed into — social media, dating apps, email, productivity "
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
    "or re-explore the DOM if you already know what's on screen — just act. Only re-orient "
    "if the page has clearly changed (after navigation, after a multi-second wait, or if "
    "your last action mutated the page in unexpected ways).\n\n"

    "## Try multiple strategies, learn from failures\n"
    "Sites vary wildly. When one approach fails, switch tactics — don't retry the same "
    "thing. The escalation ladder, fastest to slowest:\n"
    "1. **Keyboard shortcuts via BrowserPressKey** — fastest and most reliable on sites "
    "that support them (Tinder swipes, Gmail navigation, Slack message jump, etc.). "
    "Always check if the site shows keyboard hints in the UI before falling back to clicks. "
    "BrowserPressKey sends real native events that pass the `event.isTrusted` check, so "
    "it works where dispatchEvent in BrowserEvaluate silently fails.\n"
    "2. **Accessibility tree via BrowserListInteractives + BrowserClickIndex** — the "
    "accessibility tree sees roles and names that the raw DOM doesn't, even on sites "
    "like Tinder, Instagram, and TikTok that use unlabeled <div>s with click handlers. "
    "Call BrowserListInteractives to get a numbered list (`[1]<button \"Like\">`, "
    "`[2]<link \"Settings\">`), then BrowserClickIndex with the number. The click uses "
    "native OS-level mouse events so it works where DOM .click() doesn't. THIS IS YOUR "
    "GO-TO STRATEGY for unlabeled or hostile sites — try this BEFORE BrowserGetElements.\n"
    "3. **Semantic CSS selectors** — `button[aria-label='X']`, `[role='button']`, "
    "`a[href*='...']`. Try these via BrowserGetElements + BrowserClick when the site "
    "actually has semantic HTML.\n"
    "4. **Text-based JS query** — when both of the above fail, use BrowserEvaluate to "
    "find elements by visible text: `Array.from(document.querySelectorAll('*')).find(el => el.textContent.trim() === 'Like')`.\n"
    "5. **Coordinate-based fallback** — last resort: take a screenshot, identify the "
    "button visually, then click by approximate coords.\n\n"

    "## Batch known sequences with BrowserBatch\n"
    "When you have a known sequence of actions — typing then pressing Enter, "
    "swiping multiple times, clicking through pagination — emit them all in a "
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
    "use BrowserPressKey if available — it's an order of magnitude faster than DOM clicks.\n\n"

    "## When you genuinely cannot proceed\n"
    "Use RequestHumanIntervention for:\n"
    "- Login walls (the user thinks they're logged in but the session expired)\n"
    "- Captchas, 2FA prompts, age verification gates\n"
    "- Anything genuinely ambiguous about user intent\n"
    "Don't use it for normal tool failures — try a different approach first.\n\n"

    "## Tool reference\n"
    "- BrowserScreenshot: visual snapshot. Use sparingly, not after every action.\n"
    "- BrowserGetText: returns up to 15000 chars of visible text. Useful for reading "
    "content without an image.\n"
    "- BrowserScroll: handles nested scroll containers (Notion, Gmail). Returns "
    "atTop/atBottom — stop looping when scroll delta is 0.\n"
    "- BrowserGetElements: enumerate interactive elements with selectors.\n"
    "- BrowserClick / BrowserType: standard DOM interaction.\n"
    "- BrowserPressKey: native key events (preferred for shortcuts).\n"
    "- BrowserEvaluate: arbitrary JS for everything else, including text-based element "
    "search and reading state. Avoid for scrolling and keyboard events.\n"
    "- BrowserWait: 1-3s after navigation, 0.5s after most clicks.\n\n"

    "Complete the task autonomously and report a clear, brief summary."
)

MAX_TURNS = 40

# Tools that count as "action tools" — calling any of these in a turn requires
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


async def execute_browser_tool(
    tool_name: str, tool_input: dict, browser_id: str, tab_id: str = "",
) -> dict:
    """Execute a browser tool via ws_manager directly (no MCP/HTTP round-trip)."""
    action = ACTION_MAP.get(tool_name)
    if not action:
        return {"error": f"Unknown browser tool: {tool_name}"}

    params = {k: v for k, v in tool_input.items()}
    request_id = uuid4().hex
    result = await ws_manager.send_browser_command(
        request_id, action, browser_id, params, tab_id=tab_id,
    )
    return result


def _format_tool_result(result: dict, tool_name: str) -> list[dict]:
    """Convert a browser command result dict into Anthropic API content blocks."""
    if "error" in result:
        return [{"type": "text", "text": f"Error: {result['error']}"}]

    if tool_name == "BrowserScreenshot" and result.get("image"):
        blocks = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": result["image"],
                },
            },
            {"type": "text", "text": f"Screenshot captured. URL: {result.get('url', 'unknown')}"},
        ]
        return blocks

    text = result.get("text", json.dumps(result))
    return [{"type": "text", "text": str(text)}]


async def _request_browser_approval(
    session: AgentSession, tool_name: str, tool_input: dict,
) -> dict:
    """Send an approval request for a browser sub-agent tool and wait for the decision."""
    request_id = uuid4().hex
    approval_req = ApprovalRequest(
        id=request_id,
        session_id=session.id,
        tool_name=tool_name,
        tool_input=tool_input,
    )
    session.pending_approvals.append(approval_req)
    session.status = "waiting_approval"

    await ws_manager.send_to_session(session.id, "agent:status", {
        "session_id": session.id,
        "status": "waiting_approval",
    })

    try:
        decision = await asyncio.wait_for(
            ws_manager.send_approval_request(
                session.id, request_id, tool_name, tool_input,
            ),
            timeout=300.0,
        )
    except asyncio.TimeoutError:
        decision = {"behavior": "deny", "message": "Approval timed out"}

    session.pending_approvals = [
        a for a in session.pending_approvals if a.id != request_id
    ]
    session.status = "running"
    await ws_manager.send_to_session(session.id, "agent:status", {
        "session_id": session.id,
        "status": "running",
    })
    return decision


async def run_browser_agent(
    task: str,
    browser_id: str,
    model: str,
    dashboard_id: str | None = None,
    tab_id: str = "",
    pre_selected: bool = False,
    initial_url: str | None = None,
    parent_session_id: str | None = None,
) -> dict:
    """Run a browser sub-agent loop for a single browser card.

    Creates a visible AgentSession, streams progress via WebSocket,
    and returns the full action log + summary + final screenshot.
    """
    from backend.apps.agents.agent_manager import agent_manager

    _browser_perms = load_builtin_permissions()

    session_id = uuid4().hex
    cancel_event = asyncio.Event()
    session = AgentSession(
        id=session_id,
        name=f"Browser Agent",
        model=model,
        mode="browser-agent",
        status="running",
        dashboard_id=dashboard_id,
        browser_id=browser_id,
        system_prompt=SYSTEM_PROMPT,
        parent_session_id=parent_session_id,
    )
    session._cancel_event = cancel_event
    agent_manager.sessions[session_id] = session

    # If parent was already stopped before we registered, bail immediately
    if parent_session_id:
        parent = agent_manager.sessions.get(parent_session_id)
        if parent and parent.status == "stopped":
            cancel_event.set()

    await ws_manager.send_to_session(session_id, "agent:status", {
        "session_id": session_id,
        "status": "running",
        "session": session.model_dump(mode="json"),
    })

    if initial_url:
        nav_result = await execute_browser_tool(
            "BrowserNavigate", {"url": initial_url}, browser_id, tab_id,
        )
        logger.info(f"Browser agent {session_id}: navigated to {initial_url}: {nav_result.get('text', nav_result.get('error', ''))}")

    from backend.apps.settings.settings import load_settings
    from backend.apps.settings.credentials import get_anthropic_client_for_model
    from backend.apps.agents.providers.registry import (
        _find_builtin_model,
        resolve_model_id_for_sdk,
        resolve_aux_model,
    )
    browser_settings = load_settings()
    # Resolve the model string to whatever the SDK / 9Router expects.
    # When the parent session is running on a non-Claude model (e.g. gpt-5.4),
    # the browser agent inherits it and we route through 9Router's prefix.
    # Tool-use fidelity for browser-specific tools (BrowserNavigate, click,
    # type, etc.) through 9Router's claude→openai translator is UNVERIFIED —
    # if translation is poor, the user should manually switch this session
    # back to Claude in the model picker.
    if _find_builtin_model(model) is not None:
        api_model = resolve_model_id_for_sdk(model, browser_settings)
    else:
        # Unknown model string — fall back to whatever aux model is available
        try:
            api_model, _ = await resolve_aux_model(browser_settings, preferred_tier="haiku")
        except ValueError:
            # Nothing connected at all — surface a clear error so the caller
            # (parent agent) sees it in the tool result instead of crashing
            # on a 400 from 9Router.
            session.status = "error"
            error_text = (
                "Browser agent requires an active LLM subscription. "
                "Connect Claude, Codex, or Gemini in Settings."
            )
            err_msg = Message(role="system", content=f"Error: {error_text}")
            session.messages.append(err_msg)
            await ws_manager.send_to_session(session_id, "agent:message", {
                "session_id": session_id,
                "message": err_msg.model_dump(mode="json"),
            })
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "error",
                "session": session.model_dump(mode="json"),
            })
            return {
                "session_id": session_id,
                "browser_id": browser_id,
                "summary": f"Error: {error_text}",
                "action_log": [],
                "final_screenshot": None,
            }
    # Route the client based on the resolved model id, not just
    # connection_mode. Without this, a pinned-route value like "sonnet-cc"
    # resolves to "cc/claude-sonnet-4-6" but the old get_anthropic_client()
    # still returned an OpenSwarm-proxy client (because connection_mode was
    # openswarm-pro), which then rejected the cc/ prefix and surfaced as a
    # misleading "OpenSwarm servers are busy" error.
    client = get_anthropic_client_for_model(browser_settings, api_model)

    # Resume prior conversation on this browser if we have one cached. This
    # lets the sub-agent skip the "take a screenshot to figure out where I am"
    # cycle every time the parent issues a new task. Defensively validate
    # the cache — if it's somehow corrupted (orphaned tool_use_ids), drop
    # it and start fresh rather than crash on the next API call.
    prior_messages = _browser_history.get(browser_id) or []
    if prior_messages and not _validate_message_pairing(prior_messages):
        logger.warning(
            f"[browser-agent {session_id}] cached history for {browser_id} has "
            f"orphaned tool_use_ids — dropping cache and starting fresh"
        )
        _browser_history.pop(browser_id, None)
        prior_messages = []
    messages: list[dict] = list(prior_messages) + [{"role": "user", "content": task}]
    action_log: list[dict] = []
    final_screenshot: str | None = None

    # Loop detection state — sliding window of recent state-mutating tool calls
    recent_tool_calls: list[tuple[str, str, str]] = []
    loop_trigger_count = 0

    user_msg = Message(role="user", content=task)
    session.messages.append(user_msg)
    await ws_manager.send_to_session(session_id, "agent:message", {
        "session_id": session_id,
        "message": user_msg.model_dump(mode="json"),
    })

    async def _cancellable(coro):
        """Race any awaitable against the cancel event. Returns None if cancelled."""
        task = asyncio.ensure_future(coro)
        cancel_wait = asyncio.ensure_future(cancel_event.wait())
        done, pending = await asyncio.wait(
            [task, cancel_wait], return_when=asyncio.FIRST_COMPLETED,
        )
        for p in pending:
            p.cancel()
        if cancel_event.is_set():
            return None
        return task.result()

    text_parts = []  # initialized before loop so post-loop summary (line ~1294) has a default
    try:
        for turn in range(MAX_TURNS):
            if cancel_event.is_set():
                break

            response = await _cancellable(client.messages.create(
                model=api_model,
                max_tokens=4096,
                system=SYSTEM_PROMPT,
                tools=BROWSER_TOOLS_SCHEMA,
                messages=messages,
            ))
            if response is None:
                break
            # Guard against empty content (e.g. upstream API error from
            # 9Router that the SDK parsed into a partial response object).
            if not response.content:
                logger.warning(f"Browser agent {session_id}: empty response content from {api_model}")
                break

            # Track token usage from browser agent API calls
            if hasattr(response, 'usage') and response.usage:
                session.tokens["input"] = session.tokens.get("input", 0) + (response.usage.input_tokens or 0)
                session.tokens["output"] = session.tokens.get("output", 0) + (response.usage.output_tokens or 0)

            assistant_content = []
            text_parts = []
            tool_uses = []

            for block in response.content:
                if block.type == "text":
                    text_parts.append(block.text)
                    assistant_content.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    tool_uses.append(block)
                    assistant_content.append({
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    })

            if text_parts:
                asst_msg = Message(
                    role="assistant",
                    content="\n".join(text_parts),
                )
                session.messages.append(asst_msg)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": asst_msg.model_dump(mode="json"),
                })

            for tu in tool_uses:
                tool_msg = Message(
                    role="tool_call",
                    content={"id": tu.id, "tool": tu.name, "input": tu.input},
                )
                session.messages.append(tool_msg)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": tool_msg.model_dump(mode="json"),
                })

            messages.append({"role": "assistant", "content": assistant_content})

            if response.stop_reason != "tool_use":
                break

            tool_results = []
            cancelled = False

            # Sort tool_uses so ReportProgress is always processed first within
            # a turn, even if the model emits it after action tools. This way
            # the brain state is recorded before any actions execute.
            has_report_progress = any(tu.name == "ReportProgress" for tu in tool_uses)
            has_action_tools = any(
                tu.name in _ACTION_TOOLS_REQUIRING_REPORT for tu in tool_uses
            )
            # Violation: action tools without ReportProgress in the same turn.
            # The model MUST articulate its evaluation/memory/goal before acting.
            report_progress_violation = has_action_tools and not has_report_progress
            if report_progress_violation:
                logger.warning(
                    f"[browser-agent {session_id}] ReportProgress violation: "
                    f"action tools called without brain state"
                )
            # Stable sort: ReportProgress first, then everything else in order.
            tool_uses_sorted = sorted(
                tool_uses,
                key=lambda t: 0 if t.name == "ReportProgress" else 1,
            )

            for tu in tool_uses_sorted:
                if cancel_event.is_set():
                    cancelled = True
                    break

                # Handle ReportProgress — no-op execution that just records the
                # model's brain state and streams it to the dashboard.
                if tu.name == "ReportProgress":
                    eval_prev = tu.input.get("evaluation_previous", "")
                    working_mem = tu.input.get("working_memory", "")
                    next_goal = tu.input.get("next_goal", "")
                    brain_text = (
                        f"📋 **Plan**\n"
                        f"_Previous_: {eval_prev}\n"
                        f"_Memory_: {working_mem}\n"
                        f"_Next_: {next_goal}"
                    )
                    brain_msg = Message(role="assistant", content=brain_text)
                    session.messages.append(brain_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": brain_msg.model_dump(mode="json"),
                    })
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": "Progress recorded."}],
                    })
                    continue

                # Reject action tools when ReportProgress is missing this turn.
                # We MUST still emit a tool_result for every tool_use_id or the
                # next API request 400s.
                if (
                    report_progress_violation
                    and tu.name in _ACTION_TOOLS_REQUIRING_REPORT
                ):
                    rejection_text = (
                        "REJECTED: You called an action tool without first calling "
                        "ReportProgress in the same turn. ReportProgress is REQUIRED "
                        "before every batch of action tools — it's how you reflect "
                        "on what just happened and articulate your next goal. Try "
                        "again: emit ReportProgress and your action tool(s) in the "
                        "same response."
                    )
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": rejection_text}],
                        "is_error": True,
                    })
                    result_msg = Message(
                        role="tool_result",
                        content={
                            "text": rejection_text,
                            "tool_name": tu.name,
                            "elapsed_ms": 0,
                        },
                    )
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                # Handle RequestHumanIntervention — pause and wait for user
                if tu.name == "RequestHumanIntervention":
                    problem = tu.input.get("problem", "")
                    instruction = tu.input.get("instruction", "")
                    decision = await _request_browser_approval(
                        session, tu.name, {"problem": problem, "instruction": instruction},
                    )
                    if decision.get("behavior") != "deny":
                        result_text = "User resolved the issue. Continue with the task."
                    else:
                        user_message = decision.get("message", "").strip()
                        if user_message and user_message != "Skipped by user":
                            result_text = f"User skipped this intervention and said: \"{user_message}\"\nAddress what the user said and adapt your approach accordingly."
                        else:
                            result_text = "User skipped this intervention. Try a different approach or move on."
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": result_text}],
                    })
                    result_msg = Message(
                        role="tool_result",
                        content={"text": result_text, "tool_name": tu.name, "elapsed_ms": 0},
                    )
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                policy = _browser_perms.get(tu.name, "always_allow")

                if policy == "deny":
                    denied_text = f"Tool {tu.name} is denied by permission policy."
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": denied_text}],
                    })
                    result_msg = Message(
                        role="tool_result",
                        content={"text": denied_text, "tool_name": tu.name, "elapsed_ms": 0},
                    )
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id,
                        "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                if policy == "ask":
                    decision = await _request_browser_approval(
                        session, tu.name, tu.input,
                    )
                    if decision.get("behavior") == "deny":
                        denied_text = decision.get("message") or f"Tool {tu.name} denied by user."
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": tu.id,
                            "content": [{"type": "text", "text": denied_text}],
                        })
                        result_msg = Message(
                            role="tool_result",
                            content={"text": denied_text, "tool_name": tu.name, "elapsed_ms": 0},
                        )
                        session.messages.append(result_msg)
                        await ws_manager.send_to_session(session_id, "agent:message", {
                            "session_id": session_id,
                            "message": result_msg.model_dump(mode="json"),
                        })
                        continue

                start = time.time()
                result = await _cancellable(execute_browser_tool(
                    tu.name, tu.input, browser_id, tab_id,
                ))
                if result is None:
                    cancelled = True
                    break
                elapsed_ms = int((time.time() - start) * 1000)

                action_log.append({
                    "tool": tu.name,
                    "input": tu.input,
                    "result_summary": result.get("text", result.get("error", ""))[:200],
                    "elapsed_ms": elapsed_ms,
                })

                if tu.name == "BrowserScreenshot" and result.get("image"):
                    final_screenshot = result["image"]

                # Loop detection: did we just repeat the same (tool, input,
                # result) for the third time in a row? If so, attach a loud
                # warning to this tool_result so the model is forced to
                # acknowledge it on its next turn.
                call_key = _hash_tool_call(tu.name, tu.input, result)
                is_loop = _detect_loop(recent_tool_calls, call_key)
                if call_key[0] not in _LOOP_DETECTION_EXCLUDED_TOOLS:
                    recent_tool_calls.append(call_key)
                    if len(recent_tool_calls) > _LOOP_WINDOW_SIZE * 2:
                        recent_tool_calls = recent_tool_calls[-_LOOP_WINDOW_SIZE * 2:]

                content_blocks = _format_tool_result(result, tu.name)
                if is_loop:
                    loop_trigger_count += 1
                    repeat_count = sum(1 for c in recent_tool_calls if c == call_key)
                    warning = _LOOP_WARNING_TEXT.format(count=repeat_count)
                    logger.warning(
                        f"[browser-agent {session_id}] loop detected on {tu.name} "
                        f"(trigger #{loop_trigger_count}): {warning}"
                    )
                    content_blocks = content_blocks + [
                        {"type": "text", "text": f"\n\n⚠️ {warning}"}
                    ]
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": content_blocks,
                    **({"is_error": True} if is_loop else {}),
                })

                result_text = result.get("text", result.get("error", ""))
                result_msg = Message(
                    role="tool_result",
                    content={"text": result_text, "tool_name": tu.name, "elapsed_ms": elapsed_ms},
                )
                session.messages.append(result_msg)
                await ws_manager.send_to_session(session_id, "agent:message", {
                    "session_id": session_id,
                    "message": result_msg.model_dump(mode="json"),
                })

            messages.append({"role": "user", "content": tool_results})

            if cancelled:
                break

            # Hard cap on loops: if the model keeps repeating itself even
            # after we warn it, force-exit so we don't burn the entire turn
            # budget on a stuck agent.
            if loop_trigger_count >= _LOOP_HARD_CAP:
                logger.warning(
                    f"[browser-agent {session_id}] hit loop hard cap "
                    f"({_LOOP_HARD_CAP}) — force-exiting"
                )
                break

        if cancel_event.is_set():
            session.status = "stopped"
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id,
                "status": "stopped",
                "session": session.model_dump(mode="json"),
            })
            return {
                "session_id": session_id,
                "browser_id": browser_id,
                "summary": "Agent was stopped by the user. Do NOT retry or create new browser agents.",
                "error": "Agent was stopped by the user.",
                "action_log": action_log,
                "final_screenshot": final_screenshot,
            }

        summary_parts = text_parts if text_parts else ["Task completed."]
        summary = "\n".join(summary_parts)

        if not final_screenshot:
            try:
                ss_result = await execute_browser_tool(
                    "BrowserScreenshot", {}, browser_id, tab_id,
                )
                if ss_result.get("image"):
                    final_screenshot = ss_result["image"]
            except Exception:
                pass

        # Persist conversation history so the next BrowserAgent call on this
        # browser can resume rather than re-orient. Trim to the most recent
        # _MAX_HISTORY_MESSAGES turns to keep token usage bounded — but
        # never split a tool_use ↔ tool_result pair across the cut, or the
        # next API request will 400.
        _browser_history[browser_id] = _trim_history_by_turns(
            messages, _MAX_HISTORY_MESSAGES,
        )

        session.status = "completed"
        agent_manager._fire_session_completed(session)
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "completed",
            "session": session.model_dump(mode="json"),
        })

        return {
            "session_id": session_id,
            "browser_id": browser_id,
            "summary": summary,
            "action_log": action_log,
            "final_screenshot": final_screenshot,
        }

    except Exception as e:
        logger.exception(f"Browser agent {session_id} error: {e}")
        session.status = "error"
        error_msg = Message(role="system", content=f"Error: {str(e)}")
        session.messages.append(error_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id,
            "message": error_msg.model_dump(mode="json"),
        })
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": "error",
            "session": session.model_dump(mode="json"),
        })

        return {
            "session_id": session_id,
            "browser_id": browser_id,
            "summary": f"Error: {str(e)}",
            "action_log": action_log,
            "final_screenshot": None,
        }


async def _create_browser_card(dashboard_id: str, url: str, parent_session_id: str | None = None) -> str:
    """Create a new browser card on the dashboard and return its browser_id."""
    from backend.apps.dashboards.dashboards import _load, _save
    from backend.apps.dashboards.models import BrowserCardPosition, BrowserTab

    dashboard = _load(dashboard_id)
    browser_id = f"browser-{uuid4().hex[:8]}"
    tab_id = f"tab-{uuid4().hex[:8]}"
    tab = BrowserTab(id=tab_id, url=url or "https://www.google.com", title="")
    card = BrowserCardPosition(
        browser_id=browser_id,
        url=url or "https://www.google.com",
        tabs=[tab],
        activeTabId=tab_id,
        x=40,
        y=100,
        width=1280,
        height=800,
        spawned_by=parent_session_id,
    )
    dashboard.layout.browser_cards[browser_id] = card
    dashboard.updated_at = datetime.now()
    _save(dashboard)

    await ws_manager.broadcast_global("dashboard:browser_card_added", {
        "dashboard_id": dashboard_id,
        "browser_card": card.model_dump(mode="json"),
        "parent_session_id": parent_session_id or "",
    })
    return browser_id


async def run_browser_agents(
    tasks: list[dict],
    model: str,
    dashboard_id: str | None = None,
    pre_selected_browser_ids: list[str] | None = None,
    parent_session_id: str | None = None,
) -> list[dict]:
    """Run multiple browser sub-agents in parallel.

    Each task dict has: { browser_id (optional), task, url (optional) }
    Returns a list of result dicts, one per task.
    """
    from backend.apps.analytics.collector import record as _analytics
    _analytics("feature.used", {
        "feature": "browser_agent.launched",
        "task_count": len(tasks),
        "model": model,
    }, dashboard_id=dashboard_id)

    pre_selected = set(pre_selected_browser_ids or [])

    async def _run_one(task_def: dict) -> dict:
        browser_id = task_def.get("browser_id", "")
        task_text = task_def.get("task", "")
        url = task_def.get("url", "")

        if not browser_id and dashboard_id:
            browser_id = await _create_browser_card(dashboard_id, url, parent_session_id)
            await asyncio.sleep(2.0)

        is_pre_selected = browser_id in pre_selected
        return await run_browser_agent(
            task=task_text,
            browser_id=browser_id,
            model=model,
            dashboard_id=dashboard_id,
            pre_selected=is_pre_selected,
            initial_url=url if url and browser_id not in pre_selected else None,
            parent_session_id=parent_session_id,
        )

    results = await asyncio.gather(*[_run_one(t) for t in tasks], return_exceptions=True)

    final = []
    for r in results:
        if isinstance(r, Exception):
            final.append({"summary": f"Error: {str(r)}", "action_log": [], "final_screenshot": None})
        else:
            final.append(r)
    return final
