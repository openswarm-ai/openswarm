"""
Loop detection for the browser sub-agent.

Tracks recent state-mutating tool calls in a sliding window. If the model
repeats the same (tool, input) with the same result several times, we inject
an is_error message in the next tool_result to force a strategy change. This
prevents the model from burning the entire turn budget on a failing approach.
"""

import json

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
    different output; e.g. BrowserScroll on a long feed) does NOT count
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
    ",  it is not working. Try a fundamentally different strategy: "
    "(1) check the page state with BrowserScreenshot or BrowserGetText, "
    "(2) try a different selector or a different tool, "
    "(3) use BrowserPressKey for keyboard shortcuts if the site supports them, "
    "or (4) call RequestHumanIntervention if you genuinely cannot proceed."
)
