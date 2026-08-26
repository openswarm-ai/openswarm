"""
Loop detection for the browser sub-agent.

Tracks recent state-mutating tool calls in a sliding window. If the model
repeats the same (tool, input) with the same result several times, we inject
an is_error message in the next tool_result to force a strategy change. This
prevents the model from burning the entire turn budget on a failing approach.
"""

import json
import re

from backend.apps.agents.browser import browser_send_parse
from backend.apps.agents.browser.intervention_copy import (
    LOOP_WARNING_INTERVENTION_FIX,
    STAGNATION_INTERVENTION_TAIL,
)

# Tools that are read-only / idempotent and should NOT count toward loop detection. Repeating these is normal (scrolling through a feed, taking successive screenshots, polling for an element to appear).
LOOP_DETECTION_EXCLUDED_TOOLS = {
    "BrowserScreenshot",
    "BrowserGetText",
    "BrowserGetConsole",  # read-only diagnostic; reading it repeatedly is fine
    "BrowserGetElements",
    "BrowserListInteractives",  # Phase 3
    "BrowserWait",
    "ReportProgress",  # Phase 2
    "RequestHumanIntervention",
    "BrowserListSkills",      # meta: inspect own learned skills
    "BrowserDeprecateSkill",  # meta: prune a stale skill
    "BrowserRepeatFlow",      # batch: drives its own verified per-item loop
}

LOOP_WINDOW_SIZE = 5
P_LOOP_REPEAT_THRESHOLD = 2  # the SECOND identical (tool,input,result) is already a wall
LOOP_HARD_CAP = 5


# Universal close-affordance vocabulary for blocking popups (cookie walls, upsells, app-install nags, coachmarks). These phrases sit on a throwaway dismiss and NEVER on a control a real task needs (you never "No thanks" your way through a send), so a mechanical dismiss of one cannot close something the task required. Deliberately omits generic "Close"/"Dismiss"/"Skip", which DO appear on needed dialogs (e.g. "Close your conversation"). Keys on the pattern, not any one site, so it generalizes.
P_DISMISS_NAMES = frozenset({
    "no thanks", "no, thanks", "maybe later", "not now", "skip for now",
    "remind me later", "got it", "decline", "no, maybe later", "not interested",
})
# never dismiss anything that smells like security or a real decision
P_DANGER_NAME_RE = re.compile(r"verif|confirm|2fa|password|sign|pay|delete|send|post|submit", re.I)
P_ROW_RE = re.compile(r'<\s*([a-z]+)\s+"([^"]*)"', re.I)  # matches a [i]<role "name"> row


def interstitial_dismiss_target(interactives_text: str) -> str | None:
    """The accessible name of an unambiguous junk-popup close control on the
    page, or None. Conservative by construction: matches only throwaway-dismiss
    vocabulary that never sits on a task-needed control, on a button/link, and
    never anything with security/confirm/commit wording, so a mechanical dismiss
    can never close a dialog the task actually required."""
    for line in (interactives_text or "").splitlines():
        m = P_ROW_RE.search(line)
        if not m:
            continue
        role, name = m.group(1).lower(), m.group(2).strip()
        if role not in ("button", "link"):
            continue
        norm = re.sub(r"[^a-z, ]", "", name.lower()).strip()
        if norm in P_DISMISS_NAMES and not P_DANGER_NAME_RE.search(name):
            return name
    return None


def hash_tool_call(tool_name: str, tool_input: dict, result: dict) -> tuple[str, str, str]:
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


def detect_loop(
    recent_calls: list[tuple[str, str, str]],
    new_call: tuple[str, str, str],
) -> bool:
    """Return True if `new_call` constitutes a loop given recent history.

    A loop is when the same (tool, input, result) has appeared at least
    `P_LOOP_REPEAT_THRESHOLD` times within the last `LOOP_WINDOW_SIZE`
    state-mutating calls (the new call counts as one of those occurrences).
    """
    if new_call[0] in LOOP_DETECTION_EXCLUDED_TOOLS:
        return False
    window = recent_calls[-(LOOP_WINDOW_SIZE - 1):] + [new_call]
    matches = sum(1 for c in window if c == new_call)
    return matches >= P_LOOP_REPEAT_THRESHOLD


LOOP_WARNING_TEXT = (
    "LOOP DETECTED: the same action got the same result {count} times, so repeating "
    "it will NOT help. Diagnose the REAL cause before anything else, do not assume: "
    "read the exact error in the result; call BrowserGetConsole to see the page's own "
    "JS/network errors (a failed API call or crashed app is often the real reason); "
    "use BrowserEvaluate to check whether your target actually exists but is disabled, "
    "hidden, or covered by an overlay; use BrowserGetText or BrowserScreenshot to check "
    "whether the page is really a login wall, captcha, or error page. THEN fix that exact "
    "cause: a wrong selector means switch to BrowserListInteractives + BrowserClickIndex "
    "or BrowserPressKey; a blocked element means clear the blocker first; "
    + LOOP_WARNING_INTERVENTION_FIX + ". Don't just try another "
    "selector if the problem isn't a selector."
)


# --- Stagnation detection ------------------------------------------------- Distinct from the exact-repeat loop above. The agent can be "busy but stuck": trying selector A, then B, then C, all failing. The inputs differ so the exact-repeat detector never fires, yet the page never changes. We watch for a run of state-mutating actions that produced no URL change AND looked like failures (or just repeated the same observation), and nudge the model down the strategy ladder before it burns the whole turn budget.

# Read-only / meta tools don't count toward stagnation (same exemption set as the loop detector): re-orienting is not "being stuck".
P_STAGNATION_NEUTRAL_TOOLS = LOOP_DETECTION_EXCLUDED_TOOLS
STAGNATION_ESCALATION_AT = 3
STAGNATION_MAX = 5

P_FAILURE_MARKERS = (
    "error", "not found", "no longer valid", "no box model",
    "no valid bounding rect", "failed", "rejected", "timed out",
    "could not", "unable to", "denied",
)


def looks_like_failure(text: str) -> bool:
    low = text.lower()
    return any(m in low for m in P_FAILURE_MARKERS)


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
    if tool_name in P_STAGNATION_NEUTRAL_TOOLS:
        return False
    new_url = str(result.get("url") or "")
    if new_url and prev_url and new_url != prev_url:
        return False
    if "error" in result:
        return True
    text = str(result.get("text") or result.get("error") or "")
    if looks_like_failure(text):
        return True
    if prev_text and text[:200] == prev_text[:200]:
        return True
    return False


P_STAGNATION_NUDGE = (
    "NO PROGRESS: your last {streak} actions changed nothing and looked like "
    "failures. Before trying yet another variation, find out WHY: read the exact "
    "errors; call BrowserGetConsole for the page's own JS/network errors; use "
    "BrowserEvaluate to check if the target is disabled, hidden, or behind an "
    "overlay; take ONE BrowserGetText or BrowserScreenshot to confirm the "
    "page is what you think (not a login wall, captcha, or error page). Act on the "
    "real cause; only if it is truly a selector miss do you walk the ladder "
    "(BrowserListInteractives + BrowserClickIndex, then BrowserPressKey, then "
    "find-by-text with BrowserEvaluate)."
)


def stagnation_nudge(streak: int) -> str:
    base = P_STAGNATION_NUDGE.format(streak=streak)
    if streak >= STAGNATION_MAX:
        base += (
            " Switching selectors hasn't worked, so the PLAN itself is likely "
            "wrong: step back and revise your overall approach (a different page, "
            "route, or entry point), not just the selector. "
            + STAGNATION_INTERVENTION_TAIL
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
    if tool_name in P_STAGNATION_NEUTRAL_TOOLS:
        return streak, prev_url, prev_text, None
    if is_unproductive(tool_name, result, prev_url, prev_text):
        streak += 1
    else:
        streak = 0
    new_url = str(result.get("url") or "") or prev_url
    new_text = str(result.get("text") or result.get("error") or "")[:200]
    nudge = (
        stagnation_nudge(streak)
        if streak in (STAGNATION_ESCALATION_AT, STAGNATION_MAX)
        else None
    )
    return streak, new_url, new_text, nudge


def stagnation_exhausted(streak: int) -> bool:
    """True once deterministic nudging has been exhausted; the caller may then
    escalate to a one-shot aux-LLM adjudication (see browser_validator)."""
    return streak >= STAGNATION_MAX


# --- completion honesty gate ---------------------------------------------- A model that ends its turn is NOT proof the goal happened. The worst ghost we measured: multi-minute runs where every tool errored, still reported "completed". This deterministic gate reality-checks the run before we let the status say "done", so a fake success is reported as the failure it actually is.

# State-changing tools: a task that needed to DO something must land one of these.
STATE_CHANGING_TOOLS = {
    "BrowserClick", "BrowserClickIndex", "BrowserType", "BrowserNavigate",
    "BrowserPressKey", "BrowserScroll", "BrowserBatch", "BrowserActVerified",
    # Enumerated against the live dispatcher 2026-08-13 (ENG-297): these seven change state and were
    # all missing, so a run whose only actions were a delete, an upload or an API write counted as
    # having taken NO action at all, and "every state-changing action failed" could never fire on it.
    "BrowserClickByName", "BrowserClickPoint", "BrowserDeleteItem", "BrowserApiWrite",
    "BrowserUploadFile", "BrowserSaveData", "BrowserRepeatFlow",
}
# Read/extract tools: a look-only task's evidence is that a read returned content.
READ_ONLY_TOOLS = {
    "BrowserGetText", "BrowserGetElements", "BrowserListInteractives",
    "BrowserListRoutes", "BrowserReplayRoute", "BrowserScreenshot", "BrowserEvaluate",
}


# A card the agent can't make progress on, EITHER gone (closed/dashboard not open; unrecoverable) OR hung (a wedged tab where every command times out / the page never responds). Both look the same to the agent: retrying just burns time (the 20-minute LinkedIn spin), so we fail fast. The streak (reset on any good result) absorbs a one-off transient; only a SUSTAINED pattern trips it, so a merely-busy page that recovers is never mistaken for dead.
P_CARD_GONE_MARKERS = (
    "not an electron webview",   # card closed / destroyed
    "no dashboard is connected", # dashboard view not mounted
    "command timed out",         # hung: the command never came back
    "page unresponsive",         # hung: smart-wait gave up probing the tab
)
CARD_GONE_LIMIT = 2  # consecutive misses before we give up (absorbs a transient)


def card_is_unavailable(result: dict) -> bool:
    err = str(result.get("error") or "").lower()
    return any(m in err for m in P_CARD_GONE_MARKERS)


# Errors where the action MISSED but the page is alive (stale index after a reshuffle, a transient overlay covering the target, off-screen). The page itself is fine, so re-attaching the CURRENT element list to the error lets the model re-act next turn instead of burning a turn re-listing. This NEVER retries the action (no double-send risk); it only enriches the error with fresh state.
P_RECOVERABLE_ERR_MARKERS = (
    "no longer valid", "no node with given id", "page may have changed",
    "covered it", "obscured", "intercepted", "not clickable",
    "box model", "try scrolling", "not visible",
)


def recoverable_tool_error(err: str) -> bool:
    """True for a 'the action missed but the page is alive' error worth showing
    fresh state for. False for a dead card (handled separately) or no error."""
    e = (err or "").lower()
    if not e or any(m in e for m in P_CARD_GONE_MARKERS):
        return False
    return any(m in e for m in P_RECOVERABLE_ERR_MARKERS)


# Actions that DIRTY the page so replay-from-here is no longer equivalent to a clean dispatch. Navigation and reads don't dirty anything (they just get us to the page), so the deferred replay re-check is allowed after only those.
P_REPLAY_DIRTYING_TOOLS = {
    "BrowserType", "BrowserClick", "BrowserClickIndex",
    "BrowserPressKey", "BrowserScroll", "BrowserBatch", "BrowserActVerified",
}


def replay_recheck_is_safe(action_log: list[dict]) -> bool:
    """True if nothing in the run so far has mutated page state, so switching to
    a learned-skill replay now is equivalent to replaying from a clean dispatch
    (the agent only navigated / looked around to get to the right host)."""
    return not any(a.get("tool") in P_REPLAY_DIRTYING_TOOLS for a in action_log)


# What the user ASKED FOR outranks how the sub narrated it: an info ask can never replay (the answer must be fresh), an action ask can.
P_INFO_ASK_RE = re.compile(
    r"\b(tell me|what(?:'s| is| are)|how (?:many|much)|count|list|summari[sz]e|"
    r"extract|find (?:me|out)|show me|look up|read (?:me|the)|get the|give me|which|"
    r"who (?:is|are)|report back|most (?:viewed|popular|liked|recent|rated|watched)|top \d+)\b",
    re.I,
)
P_ACTION_ASK_RE = re.compile(
    r"\b(open|go to|navigate|click|send|post|submit|fill|type|search for|log ?in|"
    r"sign ?in|upload|download|book|order|buy|add|create|delete|message|dm|text)\b",
    re.I,
)

P_DELETE_INTENT_RE = re.compile(
    r"\b(delete|remove|take ?down|unsend|retract|unpost|discard|trash)\b", re.I)


def is_removal_task(task: str) -> bool:
    """A delete/remove ask. The send-script must stand down on these: a removal task is also
    task_is_send (the classifier keys on the verb), so without this the composer fill would
    TYPE the target text and POST it (measured live: delete tasks re-posted the marker)."""
    return bool(P_DELETE_INTENT_RE.search(task or ""))


# Verbs that put something OUT into the world, as opposed to merely acting on a page. Deliberately
# narrower than task_is_send, which only means "not an informational ask" and so counts a plain
# "click the Search button": gating the skill store on THAT stopped the agent learning any click
# task at all, which is the whole speed mechanism.
P_PUBLISH_INTENT_RE = re.compile(
    r"\b(post|submit|publish|send|tweet|comment|repl(?:y|ies)|dm|message)\b", re.I)


def is_publish_task(task: str) -> bool:
    """A task whose deliverable LEAVES the machine (a post, a reply, a message).

    Keeps an unconfirmed write out of the skill store. Measured live on reddit: the composer filled,
    `send_button_found=False`, the agent blind-tapped a coordinate, nothing posted, and a one-step
    "skill" (click the body textbox) still got recorded for "create a text post and submit it".
    Replaying that reports done in one turn while posting nothing, the same ghost the removal gate
    already exists to stop.

    The verbs are also ordinary NOUNS ("the top comment", "the first post", "the first reply"), so
    an informational ask is excluded: without that, "read the top comment" scored as a publish and
    the honesty gate told the user their send was never confirmed, on a task that never sent
    anything. Failing safe here means at worst we skip a gate on a genuine write, never that we
    call a perfectly good read a failure."""
    if not P_PUBLISH_INTENT_RE.search(task or ""):
        return False
    # An explicit read-only directive settles it: the user said "do NOT submit anything", so nothing
    # was ever supposed to leave, and demanding a send receipt turns a correct read into a reported
    # failure. Measured live on reddit's own discovery probe ("Do NOT type or submit anything. Is
    # the post title/body compose form present?"), which the informational heuristic below scored as
    # a publish and this gate then failed. Reuses the SAME authority the send script declines on,
    # rather than growing a second opinion that can drift away from it.
    if browser_send_parse.is_readonly(task or ""):
        return False
    return not deliverable_is_informational("", task)


# Verbs that CHANGE the page, as opposed to leaving something in the world (is_publish_task) or
# merely acting on it. A run that reads perfectly and edits nothing has not done any of these.
P_MUTATION_INTENT_RE = re.compile(
    r"\b(edit|delete|remove|change|update|rename|replace|deploy|redeploy|install|"
    r"uninstall|enable|disable|toggle|upload|clear|save)\b", re.I)

# A question ABOUT state, which can never be an instruction to change it. Kept local to
# is_mutation_task rather than widening P_INFO_ASK_RE, because that one also decides what the skill
# store records and this needs no say there. "can you delete X" is a request, not a question, so it
# is deliberately not matched.
P_STATE_QUESTION_RE = re.compile(
    r"^(what|which|where|who|whose|when|why|is|are|does|do|did|was|were|can i|could i|"
    r"how (?:many|much|do|does))\b", re.I)


def is_mutation_task(task: str) -> bool:
    """A task whose deliverable is a CHANGED page, so reading cannot satisfy it.

    Measured 2026-08-13, 6 dispatches at a Monaco editor: a run with 3 successful reads and zero
    edits returned "Task completed." and the honesty gate agreed, because any successful read
    counted as evidence once a run took no productive action. That rule is correct for "what is on
    this page" and wrong for "change this page", and nothing distinguished them.

    Same fail-safe direction as is_publish_task: the verbs are ordinary words in informational asks
    ("what does the delete button say"), so an info ask is excluded and an explicit read-only
    directive settles it. Worst case we skip the gate on a real edit; we never call a good read a
    failure, which is the error that would make the gate untrustworthy.
    """
    if not P_MUTATION_INTENT_RE.search(task or ""):
        return False
    if browser_send_parse.is_readonly(task or ""):
        return False
    if P_STATE_QUESTION_RE.match((task or "").strip()):
        return False
    return not deliverable_is_informational("", task)


def deliverable_is_informational(summary: str, task: str = "") -> bool:
    """True if the run's final answer is GATHERED CONTENT (a list/report the model
    extracted or judged), not a short action confirmation. A deterministic replay
    reproduces clicks and navigations but CANNOT regenerate judged/collected
    information, so recording a skill for such a run would make a thin shortcut
    that replays the mechanical scaffolding and then falsely claims the whole task
    is done (the 'find me 10 X' ghost). The task's ask decides when it's clear
    (mixed asks count as informational); the summary's shape breaks ties, with the
    mandatory OUTCOME line stripped first since boilerplate made every summary
    look like a report and silently stopped all recording. Conservative +
    FAIL-SAFE: when in doubt we DON'T record, so the worst case is a lost speedup
    (re-run via the LLM), never a ghost completion."""
    t = (task or "").strip()
    if t:
        if P_INFO_ASK_RE.search(t):
            return True
        if P_ACTION_ASK_RE.search(t):
            return False
    s = (summary or "").strip()
    s = re.sub(r"OUTCOME:.*$", "", s, flags=re.S).strip()
    if len(s) > 300:
        return True
    if s.count("\n") >= 2:  # 3+ lines reads as a list/report, not a one-liner
        return True
    return False


# The literal markup a tool call is made of. If it appears in the SUMMARY, the model typed it as
# prose instead of calling anything, so every "result" it narrates alongside is invented.
P_FABRICATED_CALL_RE = re.compile(
    r"<\s*(?:antml:)?invoke\s+name\s*=|<\s*(?:antml:)?function_calls\s*>|"
    r"<\s*(?:antml:)?tool_use\s+", re.I)


def outcome_facts(action_log: list[dict]) -> dict:
    """What the run actually did, in counts a caller can check without reading the prose.

    The six bad dispatches in ENG-297 were only caught because a human noticed "3 read-only calls"
    under a "Task completed." That is a suspicious reader applying a heuristic, and a less suspicious
    pass ships the fabrication onward. These counts travel WITH the summary so a calling agent can
    distrust prose on principle instead of by intuition.

    Every key is always present, including zeros: a missing key makes a caller's check pass silently,
    which is the failure mode this exists to remove.
    """
    log = action_log or []
    mutations = [a for a in log if a.get("tool") in STATE_CHANGING_TOOLS]
    return {
        "calls": len(log),
        "mutations_attempted": len(mutations),
        "mutations_succeeded": len([a for a in mutations if a.get("ok")]),
        "reads_with_content": len([
            a for a in log
            if a.get("tool") in READ_ONLY_TOOLS and a.get("ok")
            and str(a.get("result_summary") or "").strip()
        ]),
    }


def summary_fabricates_tool_calls(summary: str) -> bool:
    """True when a run's summary contains tool-call MARKUP rather than a report.

    Measured 2026-08-13 (ENG-297): one dispatch printed `<invoke name="BrowserEvaluate">` as text
    with plausible return values for three file lines, on an action log of 2 read-only calls. The
    caller treated it as real output and escalated a fabricated prompt-injection to the user as a
    security incident.

    Deliberately keys on the MARKUP, not on tool names: agents name tools in honest prose all the
    time ("BrowserClick failed so I used BrowserClickIndex"), and flagging that would fail good runs.
    """
    return bool(P_FABRICATED_CALL_RE.search(summary or ""))


def completion_is_honest(
    action_log: list[dict], publish_task: bool = False, send_confirmed: bool = False,
    mutation_task: bool = False, summary: str = "",
) -> tuple[bool, str]:
    """Reality-check a run the model declared done. Returns (honest, reason).

    Conservative by design (it can flip a 'completed' into an error, so it must
    not cry wolf on a real success): it flags ONLY the unambiguous ghosts, a run
    that took zero actions, one whose every state-changing action errored, or one
    that only looked around (no action and no read returned content). A read-only
    task stays honest as long as some read came back with content; a partially
    erroring run that still landed a real action stays honest.
    """
    # A publish task has exactly ONE deliverable: the thing leaving the machine. Clicks that
    # "succeeded" are not evidence it went out. Measured live on reddit 2026-07-31: the composer
    # filled, no send control was ever found (`send_button_found=False`), the agent blind-tapped a
    # percentage coordinate, every action reported ok, and the user was told "Done, I sent it for
    # you" while r/test never received a thing. Checked FIRST because it is the most serious lie we
    # can tell. Note the direction of the residual risk: autosend sets send_confirmed the moment its
    # click runs (a resend guard, not proof), so this can still let a bad send through, but it can
    # never newly flag a run that had any send signal at all.
    # Checked before anything else: a summary built out of invented tool calls is not a weaker
    # completion, it is a fabrication, and every other signal in the run is downstream of it.
    if summary_fabricates_tool_calls(summary):
        return False, ("the report contains fabricated tool-call markup, so its results were "
                       "narrated rather than obtained; nothing in it can be trusted")
    if publish_task and not send_confirmed:
        return False, ("the send was never confirmed, so it may not have gone out; "
                       "check the page before trusting this")
    if not action_log:
        return False, "declared done without taking a single action"
    actions = [a for a in action_log if a.get("tool") in STATE_CHANGING_TOOLS]
    actions_ok = [a for a in actions if a.get("ok")]
    # Prestage seeds two reads into the log before the model ever runs. They are real page content,
    # so a model that ANSWERS from them did honest work (a read task needs no further tools). But a
    # child that produced no answer at all did nothing, and on 2026-08-20 the seeds alone let every
    # such child pass as "Task completed" while its parent was handed an empty result. The seeds
    # therefore count only when there is an answer for them to have fed.
    p_answered = bool(str(summary or "").strip())
    reads_ok = [
        a for a in action_log
        if a.get("tool") in READ_ONLY_TOOLS and a.get("ok")
        and (p_answered or not a.get("seeded"))
        and str(a.get("result_summary") or "").strip()
    ]
    if actions and not actions_ok:
        return False, "every state-changing action failed"
    # A task that asked for a CHANGE cannot be satisfied by reading. BrowserEvaluate counts here
    # even though it is filed as a read, because on an edit task running JS IS how the edit happens
    # (the one honest dispatch in the ENG-297 run did exactly that, ~12 times); refusing it would
    # fail the only agent that did the work, which is the false positive that discredits the gate.
    if mutation_task and not actions_ok and not any(
        a.get("tool") == "BrowserEvaluate" and a.get("ok") for a in action_log
    ):
        return False, ("the task asked for a change but no state-changing action succeeded; "
                       "nothing on the page was edited")
    if not actions and not reads_ok:
        return False, "only looked around: no action taken and no content read back"
    return True, ""
