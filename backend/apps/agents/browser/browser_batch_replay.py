"""
Intra-run batch replay: do a mechanical sub-flow ONCE, then replay it for many
inputs without re-screenshotting/re-analyzing each time.

The case (the user's): the agent searches LinkedIn and reads person A's profile,
realizes it must do the same for B, C, D... Instead of the full
screenshot->analyze->decide loop per person, it hands us the step template (with
{{value}} where the input varies) + the list of values, and we replay it per
value at machine speed: zero screenshots, zero LLM turns.

Held to extreme rigor because this is the HIGHEST ghost-risk feature, per-item
pages vary (profile A has "Message", B is connect-only, C hits a wall), so blind
replay would click the wrong thing and claim success it didn't earn:

1. VERIFY EVERY STEP, FALL BACK NEVER GHOST. Each step's result is checked; the
   instant an item's page doesn't match the template (any step errors), that
   item is abandoned and reported as needs-manual, the loop never pretends.
   Honest tally always: "did N of M; these need you."

2. SENDS ARE GATED, READS ARE FREE. Read/search/navigate loops are safe and run
   freely. Any irreversible step (click "Send"/"Submit"/"Connect"/"Pay"/..., or
   typing into a message composer) makes the whole template unsafe to auto-replay,
   we refuse and tell the agent to do those one at a time with confirmation. A
   ghost in a send-loop isn't slow, it's wrong messages, so we don't allow it.

3. NETWORK-FIRST WHERE POSSIBLE. A step can be a `replay_route` (hit a captured
   API endpoint with the value substituted) instead of clicking the UI, the fast,
   reliable tier the audit found we use ~0% of the time. A read-loop over an
   endpoint is dramatically faster than navigating N pages.

This module is the PURE, browser-free core (validate / gate / fill); the execute+
verify+report loop lives in browser_agent where the executor is.
"""

import re

PLACEHOLDER = "{{value}}"

# Agent-facing step action -> (tool_name, the param keys it carries).
_STEP_TOOLS: dict[str, tuple[str, tuple[str, ...]]] = {
    "navigate":     ("BrowserNavigate",    ("url",)),
    "get_text":     ("BrowserGetText",     ()),
    "evaluate":     ("BrowserEvaluate",    ("expression",)),
    "type":         ("BrowserType",        ("selector", "text")),
    "click":        ("BrowserClickByName", ("role", "name")),
    "press_key":    ("BrowserPressKey",    ("key",)),
    "scroll":       ("BrowserScroll",      ("direction", "amount")),
    "replay_route": ("BrowserReplayRoute", ("url",)),  # the fast network tier
}

# Reads/navigation don't mutate anything irreversible; safe to loop freely.
_READONLY_ACTIONS = {"navigate", "get_text", "evaluate", "scroll", "replay_route"}

# Irreversible / outward-facing words on a clicked control. Conservative on
# purpose: we'd rather refuse a borderline loop than auto-send 10 messages.
_SEND_NAME_RE = re.compile(
    r"\b(send|submit|post|publish|connect|invite|follow|like|react|comment|reply|"
    r"share|message|dm|pay|buy|order|checkout|purchase|place\s*order|book|"
    r"confirm|apply|accept|decline|delete|remove|unsend|withdraw|endorse)\b",
    re.I,
)
# A field that reads like a message/comment composer; typing here is part of a send.
_COMPOSE_SEL_RE = re.compile(r"message|compose|comment|msg|reply|editor|body|tweet|post", re.I)


def is_send_step(step: dict) -> bool:
    """True if this step is irreversible / outward-facing, so the whole loop must
    be gated rather than auto-replayed."""
    action = step.get("action")
    if action == "click" and _SEND_NAME_RE.search(str(step.get("name") or "")):
        return True
    if action == "type" and _COMPOSE_SEL_RE.search(str(step.get("selector") or "")):
        return True
    return False


def validate_template(steps) -> tuple[bool, str]:
    """Structural check: non-empty, every step a known action with its required
    fields present. Returns (ok, reason)."""
    if not isinstance(steps, list) or not steps:
        return False, "no steps provided"
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            return False, f"step {i+1} is not an object"
        action = step.get("action")
        spec = _STEP_TOOLS.get(action)
        if not spec:
            return False, f"step {i+1}: unknown action {action!r} (allowed: {', '.join(_STEP_TOOLS)})"
        _, required = spec
        for key in required:
            if step.get(key) in (None, ""):
                return False, f"step {i+1} ({action}) is missing '{key}'"
    return True, ""


def template_safety(steps) -> tuple[bool, str]:
    """True if the template is safe to auto-replay (no irreversible step). On a
    send/submit step, returns (False, reason naming it) so the caller refuses and
    routes those through normal per-item confirmation."""
    for i, step in enumerate(steps):
        if is_send_step(step):
            what = step.get("name") or step.get("selector") or step.get("action")
            return False, (f"step {i+1} looks irreversible/outward-facing ({what!r}); "
                           "do sends/submits one at a time with confirmation, not in a batch")
    return True, ""


# Like _SEND_NAME_RE minus composer-openers ("Message"/"DM" buttons open a
# compose box, they don't send), so routine flows still batch freely.
_LIVE_IRREVERSIBLE_RE = re.compile(
    r"\b(send|submit|post|publish|connect|invite|follow|like|react|comment|reply|"
    r"share|pay|buy|order|checkout|purchase|place\s*order|book|"
    r"confirm|apply|accept|decline|delete|remove|unsend|withdraw|endorse)\b",
    re.I,
)


def is_replay_boundary(step: dict) -> bool:
    """The genuinely irreversible step where a learned skill's mechanical replay
    must STOP and hand to the live agent. Same as is_send_step EXCEPT a composer
    OPENER ('Message'/'DM' click) is reversible and NOT a boundary: the prefix can
    mechanically open the composer, and only the real Send (and composer typing)
    crosses to the live model. Uses the same opener-excluded wordlist the live
    send-guard already trusts, so a recorded Send still stops the prefix."""
    action = step.get("action")
    if action == "click" and _LIVE_IRREVERSIBLE_RE.search(str(step.get("name") or "")):
        return True
    if action == "type" and _COMPOSE_SEL_RE.search(str(step.get("selector") or "")):
        return True
    return False


_SEND_COMPLETED_RE = re.compile(
    r"\b(send|submit|pay|place\s*order|complete\s*(order|purchase|checkout|payment))\b",
    re.I,
)
_OPENER_ROLES = frozenset({"menuitem", "menuitemcheckbox", "menuitemradio", "link", "tab"})


def is_send_completed(step: dict) -> bool:
    """True only when the click was a non-opener role AND the label matches an
    unambiguous send-completion verb. Menuitems, links, and tabs label proximate
    UI rather than the action itself, so they never count even if their name
    matches (Drive's 'Share' menuitem was the false positive that prompted this)."""
    if step.get("action") != "click":
        return False
    role = str(step.get("role") or "").lower()
    if role in _OPENER_ROLES:
        return False
    return bool(_SEND_COMPLETED_RE.search(str(step.get("name") or "")))


def live_batch_guard(actions, seen_lines, composer_pending: bool = False) -> str:
    """Reason string if a live BrowserBatch carries an irreversible step, else ''.

    The solo-send rule was prompt-only until now; this makes it physical. A
    click_index resolves to its element line from the last attached state (an
    unresolvable index passes: it fails at execution anyway), and Enter after
    typing into a composer counts as the send it is. composer_pending arms the
    Enter check across turns: r47 typed solo then batched [Enter, wait], which
    slid past the within-batch check."""
    typed_composer = composer_pending
    for i, a in enumerate(actions or []):
        if not isinstance(a, dict):
            continue
        typ = a.get("type")
        params = a.get("params") if isinstance(a.get("params"), dict) else {}
        label = ""
        if typ == "click_index":
            prefix = f"[{params.get('index')}]"
            label = next((l for l in (seen_lines or ()) if str(l).startswith(prefix)), "")
        elif typ == "click":
            label = str(params.get("selector") or "")
        elif typ == "type":
            if _COMPOSE_SEL_RE.search(str(params.get("selector") or "")):
                typed_composer = True
            continue
        elif typ == "press_key":
            if typed_composer and str(params.get("key") or "").strip().lower() in ("enter", "return"):
                return (f"sub-action {i+1} presses Enter after typing into a message "
                        "composer, which sends it")
            continue
        else:
            continue
        # selectors hide words behind underscores/dashes (msg-form__send-button),
        # which defeat \b; flatten separators so the word check still sees them
        if label and _LIVE_IRREVERSIBLE_RE.search(re.sub(r"[_\-./#\[\]]+", " ", label)):
            return (f"sub-action {i+1} ({typ}) targets {label.strip()!r}, "
                    "which is irreversible/outward-facing")
    return ""


def send_payload_from_log(action_log, prompt: str = "") -> str:
    """The text a failed run typed into a composer-ish field, '' if it never
    reached the send zone. Gates the recovery verify-first probe: r44's retry
    SAID it would verify first then didn't, so the check must be code, not prose."""
    typed: list[str] = []
    for a in action_log or []:
        if not isinstance(a, dict):
            continue
        tool = a.get("tool")
        inp = a.get("input") if isinstance(a.get("input"), dict) else {}
        text = str(inp.get("text") or "").strip()
        if not text and tool != "BrowserBatch":
            continue
        if tool == "BrowserClickIndex":
            name = str(a.get("clicked_name") or "")
            role = str(a.get("clicked_role") or "")
            summ = str(a.get("result_summary") or "")
            # focus+type results carry no clicked fields (r47's live miss); the
            # executor's own "typed the text" wording is the surviving signal
            if _COMPOSE_SEL_RE.search(name) or (len(text) >= 20 and (
                    role == "textbox" or "typed the text" in summ.lower())):
                typed.append(text)
        elif tool == "BrowserType":
            sel = str(inp.get("selector") or "")
            if _COMPOSE_SEL_RE.search(sel) or (not sel and len(text) >= 20):
                typed.append(text)
        elif tool == "BrowserBatch":
            for sub in (inp.get("actions") or []):
                if not isinstance(sub, dict):
                    continue
                p = sub.get("params") if isinstance(sub.get("params"), dict) else {}
                sub_text = str(p.get("text") or "").strip()
                sub_sel = str(p.get("selector") or "")
                if sub.get("type") == "type" and sub_text and (
                        _COMPOSE_SEL_RE.search(sub_sel)
                        or (not sub_sel and len(sub_text) >= 20)):
                    typed.append(sub_text)
    if not typed:
        return ""
    # the task usually quotes the message; a candidate echoed there beats a
    # longer search query or a garbled retype
    for t in reversed(typed):
        if t in (prompt or ""):
            return t
    return typed[-1]


def _sub(val, value: str):
    return value if val == PLACEHOLDER else (
        val.replace(PLACEHOLDER, value) if isinstance(val, str) else val
    )


def fill_step(step: dict, value: str) -> tuple[str, dict]:
    """Turn one template step + one value into (tool_name, params) ready for
    execute_browser_tool. Substitutes {{value}} anywhere it appears."""
    action = step["action"]
    tool_name, keys = _STEP_TOOLS[action]
    params = {}
    for k in keys:
        if k in step:
            params[k] = _sub(step[k], value)
    # carry an optional role default for clicks
    if action == "click" and "role" not in params:
        params["role"] = _sub(step.get("role", ""), value)
    return tool_name, params


def fill_template(steps, value: str) -> list[tuple[str, dict]]:
    return [fill_step(s, value) for s in steps]


def is_readonly_template(steps) -> bool:
    """True if every step is a pure read/navigation (no clicks/types at all), the
    safest class of loop."""
    return all(s.get("action") in _READONLY_ACTIONS for s in steps)


# A batch READ is useless if it doesn't hand the data back. We return each item's
# read output, capped so a 20-item batch stays cheap, and stay honest about
# failures (named, with the error) and truncation (named, never silently dropped).
_MAX_ITEM_CHARS = 500
_MAX_TOTAL_CHARS = 6000


def summarize_batch(records: list[dict], readonly: bool,
                    max_item_chars: int = _MAX_ITEM_CHARS,
                    max_total_chars: int = _MAX_TOTAL_CHARS) -> str:
    """Turn per-item batch results into the text the agent gets back.

    `records`: [{value, ok, text}]. For a successful item `text` is its read
    output (the data); for a failed one it's the error. Successes show their data
    (capped); once the total budget is hit, remaining successes are listed by
    value only (so nothing is silently lost); failures are always named with a
    short reason so a partial batch never reads as 'all done'."""
    done = [r for r in records if r.get("ok")]
    failed = [r for r in records if not r.get("ok")]
    verb = "Read" if readonly else "Completed"
    lines, used, overflow = [], 0, []
    for r in done:
        body = " ".join(str(r.get("text") or "").split())[:max_item_chars]
        line = f"- {r['value']}: {body}" if body else f"- {r['value']}: (done, no content)"
        if used and used + len(line) > max_total_chars:
            overflow.append(str(r["value"]))
            continue
        lines.append(line)
        used += len(line)
    out = f"{verb} {len(done)} of {len(records)}."
    if lines:
        out += "\n" + "\n".join(lines)
    if overflow:
        out += (f"\n(+{len(overflow)} more done but not shown to save space: "
                f"{', '.join(overflow[:20])}; ask for specific ones if needed)")
    if failed:
        fails = ", ".join(
            f"{r['value']} ({' '.join(str(r.get('text') or 'failed').split())[:60]})"
            for r in failed[:20]
        )
        out += (f"\n{len(failed)} couldn't be done and need you to handle them "
                f"individually: {fails}")
    return out
