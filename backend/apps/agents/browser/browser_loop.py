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
    "BrowserListSkills",      # meta: inspect own learned skills
    "BrowserDeprecateSkill",  # meta: prune a stale skill
    "BrowserRepeatFlow",      # batch: drives its own verified per-item loop
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


# --- Stagnation detection -------------------------------------------------
# Distinct from the exact-repeat loop above. The agent can be "busy but stuck":
# trying selector A, then B, then C, all failing. The inputs differ so the
# exact-repeat detector never fires, yet the page never changes. We watch for a
# run of state-mutating actions that produced no URL change AND looked like
# failures (or just repeated the same observation), and nudge the model down
# the strategy ladder before it burns the whole turn budget.

# Read-only / meta tools don't count toward stagnation (same exemption set as
# the loop detector): re-orienting is not "being stuck".
_STAGNATION_NEUTRAL_TOOLS = _LOOP_DETECTION_EXCLUDED_TOOLS
_STAGNATION_ESCALATION_AT = 3
_STAGNATION_MAX = 5

_FAILURE_MARKERS = (
    "error", "not found", "no longer valid", "no box model",
    "no valid bounding rect", "failed", "rejected", "timed out",
    "could not", "unable to", "denied",
)


def _looks_like_failure(text: str) -> bool:
    low = text.lower()
    return any(m in low for m in _FAILURE_MARKERS)


def is_unproductive(
    tool_name: str, result: dict, prev_url: str, prev_text: str,
) -> bool:
    """True if a state-mutating action changed nothing observable.

    Productive (returns False): a URL change, or a success-shaped result, gets
    the benefit of the doubt (a click that opens a dropdown changes no URL but
    is real progress). Unproductive (returns True): an error result, a
    failure-shaped message, or the exact same observation as the previous
    action, all with no URL change. Neutral tools (screenshot, get_text, etc.)
    never count.
    """
    if tool_name in _STAGNATION_NEUTRAL_TOOLS:
        return False
    new_url = str(result.get("url") or "")
    if new_url and prev_url and new_url != prev_url:
        return False
    if "error" in result:
        return True
    text = str(result.get("text") or result.get("error") or "")
    if _looks_like_failure(text):
        return True
    if prev_text and text[:200] == prev_text[:200]:
        return True
    return False


_STAGNATION_NUDGE = (
    "NO PROGRESS: your last {streak} actions changed nothing on the page and "
    "looked like failures. STOP repeating this approach. Walk DOWN the strategy "
    "ladder: switch from CSS clicks to BrowserListInteractives + "
    "BrowserClickIndex; if that already failed, try BrowserPressKey (Tab/Enter) "
    "or use BrowserEvaluate to find the element by its visible text; take ONE "
    "BrowserScreenshot to re-orient if you are unsure what's on screen."
)


def stagnation_nudge(streak: int) -> str:
    base = _STAGNATION_NUDGE.format(streak=streak)
    if streak >= _STAGNATION_MAX:
        base += (
            " Switching selectors hasn't worked, so the PLAN itself is likely "
            "wrong: step back and revise your overall approach (a different page, "
            "route, or entry point), not just the selector. If even a fresh plan "
            "can't make progress, call RequestHumanIntervention instead of "
            "continuing to fail."
        )
    return base


def advance_stagnation(
    streak: int, prev_url: str, prev_text: str, tool_name: str, result: dict,
) -> tuple[int, str, str, str | None]:
    """Advance the stagnation streak for one executed tool.

    Neutral read/meta tools pass through unchanged (no bump, no reset). For a
    state-mutating action, bump the streak when unproductive else reset it, and
    return a nudge string when the streak crosses an escalation threshold.
    Returns (new_streak, new_prev_url, new_prev_text, nudge_or_None).
    """
    if tool_name in _STAGNATION_NEUTRAL_TOOLS:
        return streak, prev_url, prev_text, None
    if is_unproductive(tool_name, result, prev_url, prev_text):
        streak += 1
    else:
        streak = 0
    new_url = str(result.get("url") or "") or prev_url
    new_text = str(result.get("text") or result.get("error") or "")[:200]
    nudge = (
        stagnation_nudge(streak)
        if streak in (_STAGNATION_ESCALATION_AT, _STAGNATION_MAX)
        else None
    )
    return streak, new_url, new_text, nudge


def stagnation_exhausted(streak: int) -> bool:
    """True once deterministic nudging has been exhausted; the caller may then
    escalate to a one-shot aux-LLM adjudication (see browser_validator)."""
    return streak >= _STAGNATION_MAX


# --- completion honesty gate ----------------------------------------------
# A model that ends its turn is NOT proof the goal happened. The worst ghost we
# measured: multi-minute runs where every tool errored, still reported
# "completed". This deterministic gate reality-checks the run before we let the
# status say "done", so a fake success is reported as the failure it actually is.

# State-changing tools: a task that needed to DO something must land one of these.
_PRODUCTIVE_TOOLS = {
    "BrowserClick", "BrowserClickIndex", "BrowserType", "BrowserNavigate",
    "BrowserPressKey", "BrowserScroll", "BrowserBatch",
}
# Read/extract tools: a look-only task's evidence is that a read returned content.
_READ_TOOLS = {
    "BrowserGetText", "BrowserGetElements", "BrowserListInteractives",
    "BrowserListRoutes", "BrowserReplayRoute", "BrowserScreenshot", "BrowserEvaluate",
}


# A card the agent can't make progress on, EITHER gone (closed/dashboard not open;
# unrecoverable) OR hung (a wedged tab where every command times out / the page
# never responds). Both look the same to the agent: retrying just burns time (the
# 20-minute LinkedIn spin), so we fail fast. The streak (reset on any good result)
# absorbs a one-off transient; only a SUSTAINED pattern trips it, so a merely-busy
# page that recovers is never mistaken for dead.
_CARD_GONE_MARKERS = (
    "not an electron webview",   # card closed / destroyed
    "no dashboard is connected", # dashboard view not mounted
    "command timed out",         # hung: the command never came back
    "page unresponsive",         # hung: smart-wait gave up probing the tab
)
_CARD_GONE_LIMIT = 2  # consecutive misses before we give up (absorbs a transient)


def card_is_unavailable(result: dict) -> bool:
    err = str(result.get("error") or "").lower()
    return any(m in err for m in _CARD_GONE_MARKERS)


# Actions that DIRTY the page so replay-from-here is no longer equivalent to a
# clean dispatch. Navigation and reads don't dirty anything (they just get us to
# the page), so the deferred replay re-check is allowed after only those.
_REPLAY_DIRTYING_TOOLS = {
    "BrowserType", "BrowserClick", "BrowserClickIndex",
    "BrowserPressKey", "BrowserScroll", "BrowserBatch",
}


def replay_recheck_is_safe(action_log: list[dict]) -> bool:
    """True if nothing in the run so far has mutated page state, so switching to
    a learned-skill replay now is equivalent to replaying from a clean dispatch
    (the agent only navigated / looked around to get to the right host)."""
    return not any(a.get("tool") in _REPLAY_DIRTYING_TOOLS for a in action_log)


def deliverable_is_informational(summary: str) -> bool:
    """True if the run's final answer is GATHERED CONTENT (a list/report the model
    extracted or judged), not a short action confirmation. A deterministic replay
    reproduces clicks and navigations but CANNOT regenerate judged/collected
    information, so recording a skill for such a run would make a thin shortcut
    that replays the mechanical scaffolding and then falsely claims the whole task
    is done (the 'find me 10 X' ghost). Tool counts can't separate this from a
    legit search (measured: both look read-heavy), but the deliverable shape can.
    Conservative + FAIL-SAFE: when in doubt we DON'T record, so the worst case is
    a lost speedup (re-run via the LLM), never a ghost completion."""
    s = (summary or "").strip()
    if len(s) > 300:
        return True
    if s.count("\n") >= 2:  # 3+ lines reads as a list/report, not a one-liner
        return True
    return False


def completion_is_honest(action_log: list[dict]) -> tuple[bool, str]:
    """Reality-check a run the model declared done. Returns (honest, reason).

    Conservative by design (it can flip a 'completed' into an error, so it must
    not cry wolf on a real success): it flags ONLY the unambiguous ghosts, a run
    that took zero actions, one whose every state-changing action errored, or one
    that only looked around (no action and no read returned content). A read-only
    task stays honest as long as some read came back with content; a partially
    erroring run that still landed a real action stays honest.
    """
    if not action_log:
        return False, "declared done without taking a single action"
    actions = [a for a in action_log if a.get("tool") in _PRODUCTIVE_TOOLS]
    actions_ok = [a for a in actions if a.get("ok")]
    reads_ok = [
        a for a in action_log
        if a.get("tool") in _READ_TOOLS and a.get("ok")
        and str(a.get("result_summary") or "").strip()
    ]
    if actions and not actions_ok:
        return False, "every state-changing action failed"
    if not actions and not reads_ok:
        return False, "only looked around: no action taken and no content read back"
    return True, ""
