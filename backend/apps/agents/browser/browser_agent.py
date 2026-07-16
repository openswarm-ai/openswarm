"""
Browser sub-agent runner.

Provides a lightweight Anthropic API tool-use loop that drives browser
interactions directly through ws_manager (no MCP subprocess needed).
Sub-agents appear as visible AgentSession cards on the dashboard.
"""

import asyncio
import json
import logging
import os
import re
import time
from datetime import datetime
from uuid import uuid4

import anthropic

from backend.apps.agents.browser import browser_history
from backend.apps.agents.browser.browser_history import (
    MAX_HISTORY_MESSAGES,
    trim_history_by_turns,
    validate_message_pairing,
    clear_browser_history,
    PAGE_STATE_MARKER,
)
from backend.apps.agents.browser.browser_loop import (
    LOOP_DETECTION_EXCLUDED_TOOLS,
    LOOP_HARD_CAP,
    LOOP_WARNING_TEXT,
    LOOP_WINDOW_SIZE,
    detect_loop,
    hash_tool_call,
    CARD_GONE_LIMIT,
    advance_stagnation,
    card_is_unavailable,
    completion_is_honest,
    deliverable_is_informational,
    interstitial_dismiss_target,
    recoverable_tool_error,
    replay_recheck_is_safe,
    stagnation_exhausted,
)
from backend.apps.agents.browser.browser_validator import adjudicate_stuck

# Single actions the model could have folded into one BrowserBatch turn; reads, waits, and the batch tools themselves don't count toward the streak.
P_BATCHABLE_ACTION_TOOLS = {
    "BrowserNavigate", "BrowserClick", "BrowserClickIndex", "BrowserClickByName",
    "BrowserType", "BrowserPressKey", "BrowserScroll",
}

# Injected when the spin backstop trips: one chance to land a real answer from what's already gathered, instead of the loop cutting it off mid-thought.
P_WRAPUP_NUDGE = (
    "You've spent several turns looking without finishing. Wrap up NOW: call Done with the "
    "best answer you can give from what you've ALREADY gathered. For a find/list ask, put the "
    "actual items in the message and, if the site exposes fewer than asked, say so plainly and "
    "give what there is (that still counts as success). If you genuinely got nothing usable, "
    "call Done with success=false and a one-line honest reason. Do not explore or build further."
)
from backend.apps.agents.browser import browser_batch_replay
from backend.apps.agents.browser import browser_extract
from backend.apps.agents.browser import browser_metrics
from backend.apps.agents.browser import browser_playbook
from backend.apps.agents.browser import browser_save
from backend.apps.agents.browser import browser_meta_playbook
from backend.apps.agents.browser import browser_skills
from backend.apps.agents.browser import browser_wait
from backend.apps.agents.browser import browser_schema
from backend.apps.agents.browser.browser_schema import (
    ACTION_TOOLS_REQUIRING_REPORT,
    ACTION_MAP,
    APP_BRIDGE_TOOLS,
    APP_SYSTEM_PROMPT,
    APP_VISIBLE_TOOLS,
    BROWSER_TOOLS_SCHEMA,
    MAX_TURNS,
    MODEL_MAP,
    SYSTEM_PROMPT,
)
from backend.apps.agents.core.models import AgentSession, ApprovalRequest, Message
from backend.apps.agents.core.ws_manager import ws_manager, await_reconnect
from backend.apps.tools_lib.tools_lib import load_builtin_permissions

logger = logging.getLogger(__name__)

# Mutating actions that can carry an `expect` (the change they should cause) and be confirmed after running. Reads/waits aren't here, there's nothing to confirm.
P_CONFIRM_TOOLS = {
    "BrowserClick", "BrowserClickIndex", "BrowserClickByName",
    "BrowserType", "BrowserNavigate", "BrowserPressKey", "BrowserBatch",
}


def app_bridge_expression(tool_name: str, tool_input: dict) -> str:
    """JS for an app bridge tool. Each expression returns a JSON STRING (so it
    round-trips as text) and never throws; bridge errors come back as JSON."""
    if tool_name == "AppDescribe":
        call = "window.OPENSWARM_APP.describe()"
    elif tool_name == "AppGetState":
        call = "window.OPENSWARM_APP.getState()"
    else:  # AppInvoke
        name = json.dumps(tool_input.get("name", ""))
        args = json.dumps(tool_input.get("args") or {})
        call = f"window.OPENSWARM_APP.invoke({name}, {args})"
    return (
        "(function(){try{"
        "var A=window.OPENSWARM_APP;"
        "if(!A||typeof A.describe!=='function'){return JSON.stringify(null);}"
        f"var r={call};"
        "return JSON.stringify(r===undefined?null:r);"
        "}catch(e){return JSON.stringify({__error__:String((e&&e.message)||e)});}})()"
    )


# App-bridge readiness. The template ships window.OPENSWARM_APP from first paint
# but in a "not ready" state until the app calls register(...). On the agent's
# first turn the app may still be mounting (Vite cold-boot is 10-30s), so the
# reads poll briefly for the bridge to come up instead of declaring it absent.
P_BRIDGE_READY_WAIT_MS = 8000
P_BRIDGE_POLL_INTERVAL_MS = 400
p_bridge_known_absent: set[str] = set()


def parse_bridge_result(result: dict) -> object:
    """Decode the JSON string an app-bridge evaluate returns (it always returns
    JSON text and never throws). Returns the decoded value, or None when it is
    undecodable or errored at the transport level."""
    if not isinstance(result, dict) or "error" in result:
        return None
    raw = result.get("text")
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def bridge_ready(value: object) -> bool:
    """True when a decoded describe()/getState() value means a registered bridge.
    Legacy apps return a plain array (ready); the template stub returns
    {'__ready': False} until register() runs; None means no bridge present yet."""
    if isinstance(value, list):
        return True
    if isinstance(value, dict):
        return value.get("__ready") is not False and "__error__" not in value
    return value is not None


def p_app_output_id(browser_id: str) -> str | None:
    return browser_id[4:] if browser_id.startswith("app:") else None


def render_app_controls(describe_value: object) -> tuple[str, str] | None:
    """From a decoded describe() value build (rules_md, controls_md). Returns
    None when the value is not a ready, usable describe."""
    if isinstance(describe_value, list):
        rules, controls = "", describe_value
    elif bridge_ready(describe_value) and isinstance(describe_value, dict):
        rules = str(describe_value.get("rules") or "")
        controls = describe_value.get("controls") or []
    else:
        return None
    lines = ["# Controls", ""]
    for c in controls:
        if not isinstance(c, dict):
            continue
        row = f"- `{c.get('name', '')}`"
        if c.get("args"):
            row += f" args={json.dumps(c['args'])}"
        if c.get("keys"):
            row += f" [{c['keys']}]"
        if c.get("description"):
            row += f": {c['description']}"
        lines.append(row)
    controls_md = "\n".join(lines) + "\n"
    rules_md = (rules.strip() + "\n") if rules.strip() else ""
    return rules_md, controls_md


# Single-tool names -> the sub-action type they map to, so one summarizer covers
# both BrowserPressKey({key}) and a batch's {"type":"press_key","params":{key}}.
P_SINGLE_ACTION_TYPE = {
    "BrowserClick": "click", "BrowserClickIndex": "click_index",
    "BrowserClickByName": "click_name", "BrowserType": "type",
    "BrowserPressKey": "press_key", "BrowserScroll": "scroll",
    "BrowserNavigate": "navigate", "BrowserClickPoint": "click_point",
}


def p_summ_step(stype: str, params: dict) -> str:
    """Compact human label for one action step: the actual key/selector/text, not
    just the verb. This is what lets the [backend] pane show 'key:ArrowRight x5'
    instead of an opaque 'BrowserBatch'."""
    p = params or {}
    if stype == "press_key":
        return f"key:{p.get('key', '?')}"
    if stype == "click":
        return f"click({p.get('selector', '?')})"
    if stype == "click_index":
        return f"click#{p.get('index', '?')}"
    if stype == "click_point":
        return f"tap({p.get('xPercent', '?')}%,{p.get('yPercent', '?')}%)"
    if stype == "click_name":
        return f"clickName({p.get('name', '?')})"
    if stype == "type":
        return f"type({p.get('selector', '')}={str(p.get('text', ''))[:30]!r})"
    if stype == "wait":
        return f"wait({p.get('milliseconds') or p.get('until') or ''})"
    if stype == "scroll":
        return f"scroll({p.get('direction', 'down')})"
    if stype == "navigate":
        return f"nav({str(p.get('url', ''))[:60]})"
    if stype == "list_interactives":
        return "list"
    return stype or "?"


def p_collapse_steps(items: list[str]) -> str:
    """'ArrowRight, ArrowRight, ArrowRight' -> 'key:ArrowRight x3' so a 5-key
    burst reads as one token instead of scrolling the pane."""
    runs: list[list] = []
    for it in items:
        if runs and runs[-1][0] == it:
            runs[-1][1] += 1
        else:
            runs.append([it, 1])
    return ", ".join(s if n == 1 else f"{s} x{n}" for s, n in runs)


def p_summarize_action(tool_name: str, tool_input: dict) -> str:
    """One-line summary of what an action tool is about to do, or "" for pure
    reads (screenshot/list/describe/getstate) that need no action log."""
    ti = tool_input or {}
    if tool_name == "BrowserBatch":
        steps = [p_summ_step((a or {}).get("type", ""), (a or {}).get("params"))
                 for a in (ti.get("actions") or [])]
        return p_collapse_steps(steps) or "(empty batch)"
    if tool_name == "AppInvoke":
        args = ti.get("args")
        return f"{ti.get('name', '?')}" + (f"({json.dumps(args)[:60]})" if args else "")
    stype = P_SINGLE_ACTION_TYPE.get(tool_name)
    return p_summ_step(stype, ti) if stype else ""


async def execute_browser_tool(
    tool_name: str, tool_input: dict, browser_id: str, tab_id: str = "",
) -> dict:
    """Execute a browser tool via ws_manager directly (no MCP/HTTP round-trip)."""
    # One greppable line naming the actual buttons/keys/selectors this call drives,
    # so a run reads as "key:ArrowRight x5" rather than an opaque tool name. Fires
    # for action tools only (reads stay quiet) and ungated so web runs get it too.
    p_action = p_summarize_action(tool_name, tool_input)
    if p_action:
        logger.info(f"[browser-action] {tool_name}: {p_action}  -> {browser_id}")

    # App bridge tools translate to a single BrowserEvaluate against the app's
    # window.OPENSWARM_APP, so they need no frontend command-handler changes.
    if tool_name in APP_BRIDGE_TOOLS:
        action = "evaluate"
        expr = app_bridge_expression(tool_name, tool_input)
        params = {"expression": expr}

        async def p_eval_once() -> dict:
            rid = uuid4().hex
            return await ws_manager.send_browser_command(rid, action, browser_id, params, tab_id=tab_id)

        result = await p_eval_once()
        # Reads poll for the bridge to come up (app still mounting on turn 1).
        # AppInvoke does not wait: its action either exists right now or it does
        # not, and a missing action should surface immediately.
        if tool_name in ("AppDescribe", "AppGetState"):
            ready = bridge_ready(parse_bridge_result(result))
            # Only the cold-boot read polls. Once a card is memoed bridge-absent,
            # every later read takes the single eval above and skips the 8s sink;
            # that single eval still detects a bridge that came up between reads.
            if not ready and browser_id not in p_bridge_known_absent:
                waited = 0
                while waited < P_BRIDGE_READY_WAIT_MS and not ready:
                    await asyncio.sleep(P_BRIDGE_POLL_INTERVAL_MS / 1000)
                    waited += P_BRIDGE_POLL_INTERVAL_MS
                    result = await p_eval_once()
                    ready = bridge_ready(parse_bridge_result(result))
            # Record the verdict so the next read knows whether to pay the wait.
            if ready:
                p_bridge_known_absent.discard(browser_id)
            else:
                p_bridge_known_absent.add(browser_id)
        return result

    action = ACTION_MAP.get(tool_name)
    if not action:
        return {"error": f"Unknown browser tool: {tool_name}"}

    params = {k: v for k, v in tool_input.items()}
    # Self-healing click toggle + click-effect metric. Threaded for solo clicks AND batches (most clicks are batched, so gating on click_index alone misses them). handleBatch propagates these into its click_index sub-actions.
    if action in ("click_index", "batch"):
        params["selfheal"] = os.environ.get("OSW_SELFHEAL_CLICK", "1") != "0"
        if os.environ.get("OSW_CLICK_EFFECT_PROBE") == "1":
            params["effectProbe"] = True
    # Document-order interactives display (default on); OSW_DOC_ORDER=0 = legacy rank-order, for the A/B off-arm.
    if action == "list_interactives":
        params["docOrder"] = os.environ.get("OSW_DOC_ORDER", "1") != "0"
    request_id = uuid4().hex
    result = await ws_manager.send_browser_command(
        request_id, action, browser_id, params, tab_id=tab_id,
    )
    # Click telemetry lives at the top level for a solo click and inside `results[]` for a batched one; scan both.
    p_click_parts = [result] if isinstance(result, dict) else []
    if isinstance(result, dict) and isinstance(result.get("results"), list):
        p_click_parts += [r for r in result["results"] if isinstance(r, dict)]
    p_target_probe = os.environ.get("OSW_CLICK_EFFECT_PROBE") == "1"
    for p_cr in p_click_parts:
        if p_cr.get("selfHealed"):
            logger.info(f"[browser-selfheal] recovered a stale-index click via {p_cr['selfHealed']} -> {browser_id}")
        if p_cr.get("clickEffect"):
            logger.info(f"[click-effect] {p_cr['clickEffect']} -> {browser_id}")
        # The wrong-target signal a page-change metric misses: landed=False means the click point was NOT on the intended element (occluded/stale/moved).
        if p_target_probe and "clickLanded" in p_cr:
            logger.info(f"[click-target] landed={p_cr['clickLanded']} hit={str(p_cr.get('clickHit'))[:40]!r} -> {browser_id}")
    return result


def p_extract_domain(url: str) -> str | None:
    """Extract the apex domain from a URL (acme-corp.notion.so → notion.so).
    Returns None for non-http URLs."""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        host = parsed.hostname or ""
        if not host or host in ("localhost", "127.0.0.1", ""):
            return None
        parts = host.split(".")
        if len(parts) >= 2:
            return ".".join(parts[-2:])
        return host
    except Exception:
        return None


def p_api_write_result(res) -> dict:
    """Shape a registry WriteResult into a loop result: a truthful receipt on success (with
    send_confirmed set by the caller), or an `error` on a miss so the model does the write via the
    UI and the run never distills it as a false success."""
    if res.ok:
        return {"ok": True, "text": (
            f"Done via the {res.domain} API in {res.latency_ms}ms. Receipt: {res.receipt}. "
            "The write landed, that receipt is your proof; you're finished with this step."
        )}
    return {"error": f"API write not used ({res.error}). Do this action through the UI instead."}


async def run_api_write(tool_input: dict, current_url: str, browser_id: str = "", tab_id: str = "") -> dict:
    """Route a BrowserApiWrite to the API-first write tier: a deterministic built-in adapter
    (Reddit) when one exists, else the GENERAL capture-replay tier (action='route': replay a
    mutating route the site's own UI fired, verified same-origin + captured, behind OSW_ROUTE_WRITE).
    Never raises: a missing adapter / disarmed tier / site-reject is a typed miss, so the model
    falls back to the UI path, never a crash and never a false claim of success."""
    from urllib.parse import urlparse
    from backend.apps.agents.browser import route_write, site_write_registry
    action = str((tool_input or {}).get("action") or "").strip()
    if not action:
        return {"error": "BrowserApiWrite needs an 'action' (comment, reply, post, edit, delete, or route)."}
    domain = p_extract_domain(current_url or "")
    if not domain:
        return {"error": "Can't tell what site you're on yet; navigate to the site first, then do the write through the UI or retry."}

    if action == "route":
        # General tier: replay a captured mutating route. The captured set is fetched live from the
        # page (the safety wall: only a route the UI actually fired can be replayed), and the replay
        # itself is same-origin + flag-gated + session-borrowed in route_write.
        method = str(tool_input.get("method") or "POST").strip()
        url = str(tool_input.get("url") or "").strip()
        body = tool_input.get("body") if isinstance(tool_input.get("body"), dict) else {}
        if not url:
            return {"error": "BrowserApiWrite route needs the 'url' of a captured write endpoint (see BrowserListRoutes)."}
        try:
            origin = f"{urlparse(current_url).scheme}://{urlparse(current_url).netloc}"
        except Exception:
            return {"error": "Can't resolve the current site's origin; do the write through the UI."}
        listed = await execute_browser_tool("BrowserListRoutes", {"writes": True}, browser_id, tab_id)
        captured = [route_write.CapturedRoute(method=str(r.get("method", "")), template=str(r.get("template", "")))
                    for r in (listed.get("routes") or []) if isinstance(r, dict) and r.get("template")]
        res = await site_write_registry.api_route_write(origin, method, url, body, captured)
        return p_api_write_result(res)

    params = {k: v for k, v in (tool_input or {}).items() if k not in ("action", "expect")}
    res = await site_write_registry.api_write(domain, action, params)
    return p_api_write_result(res)


def strip_lone_surrogates(s: str) -> str:
    # The JS/webview hands us page text as UTF-16, so an emoji can arrive as half of its surrogate pair; Python carries the orphan but .encode('utf-8') later (the SDK serializing the request to the LLM) detonates with "surrogates not allowed" and kills the turn. Swap any orphan for the replacement char.
    return re.sub(r"[\ud800-\udfff]", "�", s) if s else s


def format_tool_result(result: dict, tool_name: str) -> list[dict]:
    """Convert a browser command result dict into Anthropic API content blocks."""
    if "error" in result:
        return [{"type": "text", "text": strip_lone_surrogates(f"Error: {result['error']}")}]

    if tool_name == "BrowserScreenshot" and result.get("image"):
        blocks = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": result.get("image_mime", "image/png"),
                    "data": result["image"],
                },
            },
            {"type": "text", "text": f"Screenshot captured. URL: {result.get('url', 'unknown')}"},
        ]
        return blocks

    text = result.get("text", json.dumps(result))
    return [{"type": "text", "text": strip_lone_surrogates(str(text))}]


# Mutating tools whose results get fresh page state attached (the browser-use loop shape: act, settle, see), so acting and seeing are one turn, not two.
P_AUTO_STATE_TOOLS = {
    "BrowserNavigate", "BrowserClick", "BrowserClickIndex", "BrowserClickByName",
    "BrowserType", "BrowserPressKey", "BrowserScroll", "BrowserBatch",
}
# Matches the frontend's DEFAULT_INTERACTIVE_CAP (interactiveRanking.ts): a shorter cap here silently hid rows 36-60 that an explicit BrowserListInteractives would show, forcing the model to re-list the very elements it just acted on. Delta compression keeps the common attach small, so the worst case (a full 60-row attach) is bounded and rare.
P_AUTO_STATE_MAX_LINES = 60
P_AUTO_SETTLE_CAPS_MS = {"BrowserNavigate": 2500, "BrowserBatch": 1500}

# URL shapes that mean "a list of candidates to pick from" (auto candidate scan)
RESULTS_URL_RE = re.compile(
    r"[?&](q|query|keywords|search|search_query|find|term)=|/search\b|/results\b", re.I,
)
P_AUTO_SCAN_MAX_PER_RUN = 2
# The candidate scan is a fast HINT, not the critical path. Cap the aux input to the top of the
# page (matches are first) and bail quickly, so a big page can't turn the scan into dead idle time
# (a real 8s stall was measured on LinkedIn search). Head slice + short timeout = finishes-or-skips.
P_SCAN_TEXT_CAP = 8000
P_SCAN_TIMEOUT_S = 4.0


def p_batch_ends_with_read(tool_input: dict) -> bool:
    actions = (tool_input or {}).get("actions") or []
    return bool(actions) and (actions[-1] or {}).get("type") == "list_interactives"


def p_truncate_state(text: str, max_lines: int = P_AUTO_STATE_MAX_LINES) -> str:
    lines = str(text).splitlines()
    if len(lines) <= max_lines:
        return str(text)
    return "\n".join(lines[:max_lines]) + (
        f"\n(+{len(lines) - max_lines} more rows; call BrowserListInteractives for the full list)"
    )


def delta_state(text: str, seen_lines: set[str]) -> str:
    """Shrink an attached element list to the rows that changed since the last
    attach; stable indices make a line's identity meaningful, so re-sending 30
    unchanged rows every action is pure token burn. Mutates `seen_lines` to the
    new baseline. Small overlaps just resend the full list (a reshuffle)."""
    rows = [l for l in str(text).splitlines() if l.startswith("[")]
    cur = set(rows)
    prev = set(seen_lines)
    seen_lines.clear()
    seen_lines.update(cur)
    if not prev or not rows:
        return text
    fresh = [l for l in rows if l not in prev]
    unchanged = len(rows) - len(fresh)
    if unchanged < 6:
        return text
    if not fresh:
        return f"(all {unchanged} element rows unchanged since your last look; same numbers still valid)"
    return "\n".join(fresh) + (
        f"\n(+{unchanged} rows unchanged since your last look; their numbers are still valid)"
    )


# A button row whose name is exactly a Send control (not "Send InMail credit" or "Send a message to X"); used to hand the model the Send button after it types, so it never burns turns hunting a button that's right there.
P_SEND_ROW_RE = re.compile(r'\[(\d+)\]\*?<\s*button\s+"([^"]*)"', re.I)

# TIGHT set for the ALWAYS-ON model hint (post_action_state). Kept to the unambiguous "Send" family
# on purpose: this hint fires after ANY text fill, so a broad match ("Reply"/"Share"/"Comment"/
# "Post") would mislabel a stray feed button as the Send button after an unrelated search fill.
P_HINT_SEND_LABELS = frozenset({"send", "send now", "send message"})
# BROAD submit vocabulary for the SEND-SCRIPT only (flag-gated + receipt-gated): lets the fast
# send-path COMPLETE on X/IG/FB/Threads/YouTube. Safe ONLY there because the send-script re-verifies
# the composer cleared the exact payload, so an opener-vs-submit mismatch fails safe, never a false
# send. button-only (P_SEND_ROW_RE) + exact match keeps "Post" from matching "Post a job" etc.
P_SEND_LABELS = frozenset({
    "send", "send now", "send message",              # LinkedIn / Gmail / DMs
    "post", "post all", "tweet", "reply",            # X / Threads compose + reply
    "publish", "comment", "share",                   # articles / YouTube+FB comments / shares
})


def send_index_in_state(state_text: str):
    """(index, name) of a real Send button for the ALWAYS-ON model hint, or None. TIGHT exact match
    (Send family only) so it never mislabels a common feed 'Reply'/'Share'/'Comment' button."""
    for line in (state_text or "").splitlines():
        m = P_SEND_ROW_RE.search(line)
        if m and m.group(2).strip().lower() in P_HINT_SEND_LABELS:
            return int(m.group(1)), m.group(2)
    return None


def send_submit_index_in_state(state_text: str):
    """(index, name) of a submit button across the popular composers (Post/Reply/Tweet/...), for the
    receipt-gated SEND-SCRIPT only. Broader than the hint matcher; safe because the send-script
    verifies the composer cleared afterward, so a wrong match aborts, never sends."""
    for line in (state_text or "").splitlines():
        m = P_SEND_ROW_RE.search(line)
        if m and m.group(2).strip().lower() in P_SEND_LABELS:
            return int(m.group(1)), m.group(2)
    return None


# Tokens that mean the aux wrote machinery, not a user sentence: reject and fall back to a template.
P_NOT_A_REPLY = ("browser", "clickindex", "composer", "textbox", "```", "{", "index", "http")


async def compose_send_confirmation(aux_client, aux_model, task: str, payload: str) -> str:
    """The final 'done' line in the model's OWN voice, via one cheap aux call, so it isn't a
    hardcoded template. The SEND already happened in code; this only writes the words. Fail-open:
    returns '' on any error OR if the output doesn't read like a plain user sentence (tool names,
    JSON, a URL), so the caller falls back to a simple template. Aux tier = cheap + fast; a
    one-sentence confirmation needs no frontier model, and it never re-does the mechanical work."""
    if not aux_client or not aux_model or not payload:
        return ""
    prompt = (
        "You just finished a task for the user by controlling their web browser, and it SUCCEEDED.\n"
        f"The user asked: {task[:280]}\n"
        f"What you sent: \"{payload[:280]}\"\n"
        "Reply with ONE short, warm, first-person sentence confirming it's done, the way a helpful "
        'friend would (e.g. "Done, I messaged Tyler and said hi."). No technical words, no quotes '
        "wrapping the whole sentence, no preamble, just the sentence."
    )
    try:
        resp = await aux_client.messages.create(
            model=aux_model, max_tokens=80,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(getattr(b, "text", "") for b in (resp.content or [])).strip().strip('"').strip()
    except Exception:
        return ""
    low = text.lower()
    if not text or len(text) > 220 or any(t in low for t in P_NOT_A_REPLY):
        return ""
    return text


def is_composer_fill(tool_name: str, tool_input: dict) -> bool:
    """True if this action typed a message into a composer (the moment the Send
    button is about to matter). Covers the solo fill, BrowserType, and a batched
    fill, the three ways the model composes."""
    ti = tool_input or {}
    if tool_name in ("BrowserClickIndex", "BrowserType"):
        return bool(str(ti.get("text") or "").strip())
    if tool_name == "BrowserBatch":
        for a in (ti.get("actions") or []):
            p = a.get("params") or {}
            if a.get("type") in ("type", "click_index") and str(p.get("text") or "").strip():
                return True
    return False


def fill_text_of(tool_name: str, tool_input: dict) -> str:
    """The text a composer-fill action typed, '' when it isn't one."""
    ti = tool_input or {}
    if tool_name in ("BrowserClickIndex", "BrowserType"):
        return str(ti.get("text") or "").strip()
    if tool_name == "BrowserBatch":
        for a in (ti.get("actions") or []):
            p = a.get("params") or {}
            if a.get("type") in ("type", "click_index") and str(p.get("text") or "").strip():
                return str(p.get("text")).strip()
    return ""


def payload_in_textbox(state_text: str, payload: str) -> bool:
    """True if any listed textbox VALUE carries the typed payload (fill committed).
    Matches on a prefix because long payloads truncate in the list."""
    probe = (payload or "")[:24]
    if not probe:
        return False
    for line in (state_text or "").splitlines():
        if "<textbox" in line and probe in line:
            return True
    return False


async def post_action_state(
    tool_name: str, tool_input: dict, result: dict,
    browser_id: str, tab_id: str, wait_exec, goal: str,
    seen_lines: set[str] | None = None,
) -> str:
    """Settle the page after a mutating action, then return a compact fresh
    interactives list to append to its result. Empty string = attach nothing."""
    if tool_name not in P_AUTO_STATE_TOOLS or not isinstance(result, dict) or "error" in result:
        return ""
    if tool_name == "BrowserBatch" and p_batch_ends_with_read(tool_input):
        return ""
    # an `expect` confirm already ran its own smart_wait; don't settle twice
    if not str((tool_input or {}).get("expect") or "").strip():
        settle = await browser_wait.smart_wait(
            wait_exec, browser_id, tab_id, P_AUTO_SETTLE_CAPS_MS.get(tool_name, 1200),
        )
        if settle.get("hung"):
            return ""
    p_composer_fill = is_composer_fill(tool_name, tool_input)
    params = {"goal": goal} if goal else {}
    lst = None
    p_send_si = None
    if p_composer_fill:
        # The Send button lazy-renders a beat LATER than the text commits (measured: not in the AX tree even at 2.5s, worse under load), and a single re-list races that and loses, the old handoff never fired (send-ready=0 across 10 A/B legs). So POLL the actual interactives list for a REAL Send button and stop the instant it appears; this checks for the exact thing we hand over, not just 'Send' text. Deadline cut 6s->2.4s: recent sends ran the FULL 6s and still found nothing (send_button_found=False 3/3), so the long tail bought pure wall time; two polls catch the lazy-render case, the model finds Send itself past that.
        p_deadline = time.monotonic() + 2.4
        while True:
            try:
                p_l = await asyncio.wait_for(
                    wait_exec("BrowserListInteractives", params, browser_id, tab_id), timeout=5.0)
            except Exception:
                break
            if isinstance(p_l, dict) and "error" not in p_l and p_l.get("text"):
                lst = p_l
                p_send_si = send_index_in_state(p_l["text"])
                if p_send_si:
                    break
            if time.monotonic() >= p_deadline:
                break
            await asyncio.sleep(0.6)
        logger.info(f"[browser-sendwait] composer fill: send_button_found={bool(p_send_si)}")
    else:
        try:
            lst = await asyncio.wait_for(
                wait_exec("BrowserListInteractives", params, browser_id, tab_id), timeout=5.0)
        except Exception:
            return ""
    if not isinstance(lst, dict) or "error" in lst or not lst.get("text"):
        return ""
    state = lst["text"] if seen_lines is None else delta_state(lst["text"], seen_lines)
    out = f"\n\n{PAGE_STATE_MARKER}\n{p_truncate_state(state)}"
    # Fold the page's READABLE TEXT in alongside the clickable elements (flag-gated). The model perceives nearly every page TWICE, once via list_interactives and once via GetText (measured: ~52% of all tool calls are perception, half of that redundant list+text pairs). Attaching a trimmed text excerpt here means after any action it already has BOTH views, so it never spends a separate GetText turn. A cheap code-side read (ms) trades for a ~4s model turn.
    if os.environ.get("OSW_FOLD_TEXT", "0") == "1":
        try:
            p_gt = await asyncio.wait_for(
                wait_exec("BrowserGetText", {}, browser_id, tab_id), timeout=5.0)
            p_txt = str(p_gt.get("text") or "") if isinstance(p_gt, dict) and "error" not in p_gt else ""
            if p_txt:
                out += f"\n\n[Page text (you have this already, no need to GetText):]\n{p_txt[:1800]}"
        except Exception:
            pass
    # Hand the Send button's index over so the model clicks it directly instead of scanning the list or hunting via CSS/JS/screenshots (the polled list above is what makes Send actually present to point at, the two work together).
    if p_send_si:
        out = (f"\n\n[send-ready] Your message is typed and the Send button is index "
               f"{p_send_si[0]} below. To deliver, click it SOLO with BrowserClickIndex + an "
               f"`expect` proof. Do NOT hunt for it with CSS/JS/screenshots, it is right here."
               ) + out
    return out


async def p_request_browser_approval(
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


# Background learning tasks (playbook distill) held by strong ref; asyncio only weak-refs tasks, and a GC'd task dies silently mid-distill.
learn_tasks: set[asyncio.Task] = set()


async def run_browser_agent(
    task: str,
    browser_id: str,
    model: str,
    dashboard_id: str | None = None,
    tab_id: str = "",
    pre_selected: bool = False,
    initial_url: str | None = None,
    parent_session_id: str | None = None,
    app_mode: bool = False,
    user_prompt: str = "",
) -> dict:
    """Run a browser sub-agent loop for a single browser card.

    Creates a visible AgentSession, streams progress via WebSocket,
    and returns the full action log + summary + final screenshot.

    When app_mode is set, browser_id points at an OpenSwarm-built app's webview
    (registered as "app:<output_id>"). The agent drives it through the app's
    native bridge (window.OPENSWARM_APP) instead of web perception: no initial
    navigate, no AX-tree front-load, and a lean app toolset + prompt.
    """
    from backend.apps.agents.agent_manager import agent_manager

    p_browser_perms = load_builtin_permissions()

    session_id = uuid4().hex
    cancel_event = asyncio.Event()
    session = AgentSession(
        id=session_id,
        name="App Agent" if app_mode else "Browser Agent",
        model=model,
        mode="browser-agent",
        status="running",
        dashboard_id=dashboard_id,
        browser_id=browser_id,
        system_prompt=APP_SYSTEM_PROMPT if app_mode else SYSTEM_PROMPT,
        parent_session_id=parent_session_id,
    )
    agent_manager.cancel_events[session_id] = cancel_event
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

    # Perception we prefetch on a known starting page so the model can ACT on turn 1 instead of spending turns 0-2 orienting (screenshot/get_elements). Pure speed: it's the same reads the agent would do anyway, just front-loaded.
    async def p_perceive(label_url: str) -> tuple[str, str]:
        """Cheap list+text perception of the CURRENT page. Returns
        (front_load_block, current_url, read_records). The read_records are real
        reads that ran (so the completion-honesty gate knows content WAS read,
        even when the agent then answers a read task with zero further tools, the
        whole point of front-loading). Best-effort; never raises."""
        recs = []
        try:
            # The two front-load reads are independent, so fire them together: the AX-tree list (slow, occlusion-filtered) and the text read overlap instead of adding up. return_exceptions keeps it best-effort, one read failing no longer discards the other.
            li, gt = await asyncio.gather(
                execute_browser_tool("BrowserListInteractives", {}, browser_id, tab_id),
                execute_browser_tool("BrowserGetText", {}, browser_id, tab_id),
                return_exceptions=True,
            )
            if not isinstance(li, dict):
                li = {}
            if not isinstance(gt, dict):
                gt = {}
            url = li.get("url") or gt.get("url") or label_url or ""
            parts = []
            if li.get("text") and "error" not in li:
                parts.append("Interactive elements already on the page:\n" + str(li["text"]))
                recs.append({"tool": "BrowserListInteractives", "input": {}, "ok": True,
                             "result_summary": str(li["text"])[:200], "elapsed_ms": 0})
            if gt.get("text") and "error" not in gt:
                parts.append("Visible page text (truncated):\n" + str(gt["text"])[:2000])
                recs.append({"tool": "BrowserGetText", "input": {}, "ok": True,
                             "result_summary": str(gt["text"])[:200], "elapsed_ms": 0})
            block = (
                "\n\n[Page already loaded and inspected for you, act directly; "
                "no need to screenshot or list elements again unless it changes]\n"
                + "\n\n".join(parts)
            ) if parts else ""
            return block, url, recs
        except Exception as e:
            logger.debug(f"[browser-perf] perception prefetch skipped: {e}")
            return "", (label_url or ""), recs

    # current_url is the live URL of the card. When the parent delegates to an EXISTING browser (no initial_url), the backend has no record of where that card navigated to, so we read it here. Without it, skill replay could never resolve the host on a repeat task and the whole fast path stayed dead.
    preloaded_perception = ""
    current_url = ""
    preloaded_reads: list[dict] = []  # real front-loaded reads, seeded into action_log
    p_resumed = bool(browser_history.BROWSER_HISTORY.get(browser_id))
    # App mode skips this whole block: the app is already loaded and its DOM is uninformative (often a bare <canvas>), so the agent perceives via the bridge (AppDescribe) on turn 1 instead of navigating or front-loading the AX tree.
    if not app_mode:
        if initial_url:
            nav_result = await execute_browser_tool(
                "BrowserNavigate", {"url": initial_url}, browser_id, tab_id,
            )
            logger.info(f"Browser agent {session_id}: navigated to {initial_url}: {nav_result.get('text', nav_result.get('error', ''))}")
            preloaded_perception, current_url, preloaded_reads = await p_perceive(initial_url)
        elif not p_resumed:
            # Fresh task on an existing card: perceive the current page to learn its host (for replay) and front-load turn 1 (this path used to start cold).
            preloaded_perception, current_url, preloaded_reads = await p_perceive("")

    from backend.apps.settings.settings import load_settings
    from backend.apps.settings.credentials import get_anthropic_client_for_model
    from backend.apps.agents.providers.registry import (
        find_builtin_model,
        get_api_type,
        resolve_model_id_for_sdk,
        resolve_aux_model,
    )
    browser_settings = load_settings()
    # Resolve the model string to whatever the SDK / 9Router expects. When the parent session is running on a non-Claude model (e.g. gpt-5.4), the browser agent inherits it and we route through 9Router's prefix. Tool-use fidelity for browser-specific tools (BrowserNavigate, click, type, etc.) through 9Router's claude→openai translator is UNVERIFIED, if translation is poor, the user should manually switch this session back to Claude in the model picker.
    if find_builtin_model(model) is not None:
        api_model = resolve_model_id_for_sdk(model, browser_settings)
    else:
        # Unknown model string (custom provider, unrecognized id): fall back to a CAPABLE aux tier, not the cheapest. Browser work is multi-step agentic, and the cheap tier is far weaker at it (OSWorld: Haiku 4.5 50.7% vs Sonnet 4.6 72.5%), so a sonnet-class fallback is worth the cost. resolve_aux_model is provider-agnostic (picks the sonnet tier of whatever the user has connected).
        try:
            api_model, _ = await resolve_aux_model(browser_settings, preferred_tier="sonnet")
        except ValueError:
            # Nothing connected at all; surface a clear error so the caller (parent agent) sees it in the tool result instead of crashing on a 400 from 9Router.
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
    # A/B lever (flag-gated, default OFF, and it should STAY off, see below). The idea was to pin the loop to a cheap tier since mechanical browsing "rarely needs frontier reasoning". Two measurements killed it: (1) latency, n=10 live cc/ lanes 2026-07-15, opus-4-6 ~= sonnet-4-6 (~2.3s, the old "Opus->Sonnet 2x" is stale), only Haiku is ~2x/turn faster (1.2s); BUT (2) accuracy, OSWorld computer-use benchmark, Haiku 4.5 = 50.7% vs Sonnet 4.6 = 72.5% (~22pp worse). Per-turn speed is the WRONG metric: a cheap tier fails / needs more recovery turns on multi-step browser tasks, so a 2x-faster turn nets SLOWER + less reliable. Same cliff for non-Claude users (gpt-mini/gemini-flash are weaker than their frontier siblings too), so downgrading the tier hurts everyone. The real cold-start lever is FEWER TURNS on the user's OWN chosen model (plan-dispatch, batching), which preserves accuracy AND is provider-agnostic. Kept as a flag (fail-open to the inherited model) only for explicit experiments; not a default.
    p_loop_tier = os.environ.get("OPENSWARM_BROWSER_LOOP_TIER", "").strip().lower()
    if p_loop_tier in ("haiku", "sonnet"):
        try:
            p_pinned, _ = await resolve_aux_model(
                browser_settings, preferred_tier=p_loop_tier, primary_api=get_api_type(model))
            if p_pinned and p_pinned != api_model:
                logger.info(f"[browser-agent {session_id}] loop-tier pin: {api_model} -> {p_pinned} (tier={p_loop_tier})")
                api_model = p_pinned
        except Exception as e:
            logger.info(f"[browser-agent {session_id}] loop-tier pin skipped ({e}); inheriting {api_model}")
    # Route the client based on the resolved model id, not just connection_mode. Without this, a pinned-route value like "sonnet-cc" resolves to "cc/claude-sonnet-4-6" but the old get_anthropic_client() still returned an OpenSwarm-proxy client (because connection_mode was openswarm-pro), which then rejected the cc/ prefix and surfaced as a misleading "OpenSwarm servers are busy" error.
    client = get_anthropic_client_for_model(browser_settings, api_model)

    # Skill key, derived EARLY so both the prestage-skip below and the replay lookup share it. Prefer the USER's original request over the orchestrator's reformulation (reformulations vary run-to-run and silently break exact-key replay); multi-quoted messages fall back to the differentiated task.
    skill_key_task = task
    if parent_session_id:
        try:
            p_psess = agent_manager.get_session(parent_session_id)
            if p_psess:
                for p_m in reversed(p_psess.messages):
                    if p_m.role == "user" and isinstance(p_m.content, str) and p_m.content.strip():
                        p_orig = p_m.content.strip()
                        if len(browser_skills.template_task(p_orig)[1]) <= 1:
                            skill_key_task = p_orig
                        break
        except Exception:
            pass
    # A learned skill's replayed prefix does the same navigation prestage would aux-drive (~8-12s): when one exists for this host+task, skip prestage and let the replay own the nav.
    p_early_host = browser_skills.host_of(initial_url or current_url or next(iter(re.findall(r"https?://\S+", task)), ""))
    p_skip_prestage_for_skill = bool(p_early_host and browser_skills.find_skill(p_early_host, skill_key_task))
    if p_skip_prestage_for_skill:
        logger.info(f"[browser-skills] skill exists for {p_early_host}; skipping prestage (replay owns the nav)")

    from backend.apps.agents.browser import browser_prestage
    if (browser_prestage.prestage_enabled() and not app_mode and not cancel_event.is_set()
            and not p_skip_prestage_for_skill):
        try:
            p_ps_block, p_ps_url, p_ps_recs = await asyncio.wait_for(
                browser_prestage.run_prestage(
                    task, browser_id, tab_id, current_url, browser_settings,
                    get_api_type(model), execute_browser_tool,
                ),
                timeout=browser_prestage.TOTAL_TIMEOUT_S + 10,
            )
            if p_ps_block:
                preloaded_perception = p_ps_block
                current_url = p_ps_url or current_url
                preloaded_reads.extend(p_ps_recs)
        except Exception as e:
            logger.info(f"[browser-prestage] outer skip ({e})")

    # Resume prior conversation on this browser if we have one cached. This lets the sub-agent skip the "take a screenshot to figure out where I am" cycle every time the parent issues a new task. Defensively validate the cache; if it's somehow corrupted (orphaned tool_use_ids), drop it and start fresh rather than crash on the next API call.
    prior_messages = browser_history.BROWSER_HISTORY.get(browser_id) or []
    if prior_messages and not validate_message_pairing(prior_messages):
        logger.warning(
            f"[browser-agent {session_id}] cached history for {browser_id} has "
            f"orphaned tool_use_ids; dropping cache and starting fresh"
        )
        clear_browser_history(browser_id)
        prior_messages = []
    # App mode: read the bridge's rules + controls ONCE up front and front-load them so the agent knows the app's purpose and every control before its first action (no screenshot fumbling) and need not call AppDescribe again until controls change. Also the runtime bridge gate: if the bridge never comes up, fail loudly into the logs + the agent's first message (and, under OPENSWARM_REQUIRE_BRIDGE=1, end the run rather than UI-fumble).
    # NOTE: app mode runs this on EVERY task, even a resumed conversation; the bridge can appear between runs (app just made agent-operable) and a resumed history may carry a stale "no bridge, screenshot it" strategy, so re-reading + re-attaching the controls each task re-points the agent at the bridge.
    app_front_load = ""
    if app_mode:
        try:
            p_dv = parse_bridge_result(await execute_browser_tool("AppDescribe", {}, browser_id, tab_id))
        except Exception:
            p_dv = None
            logger.debug("[app-agent] startup AppDescribe failed", exc_info=True)
        p_rendered = render_app_controls(p_dv)
        if p_rendered:
            p_rules_md, p_controls_md = p_rendered
            p_rev = p_dv.get("__rev") if isinstance(p_dv, dict) else None
            p_block = [
                "\n\n[The app's bridge is live; its rules and controls were read "
                "for you. Act directly; do NOT call AppDescribe again unless "
                "AppGetState reports a changed __rev.]"
            ]
            if p_rules_md.strip():
                p_block.append("App rules / objective:\n" + p_rules_md.strip())
            p_block.append(p_controls_md.strip())
            if p_rev is not None:
                p_block.append(f"(controls __rev: {p_rev})")
            app_front_load = "\n\n".join(p_block)
        else:
            p_oid = p_app_output_id(browser_id) or browser_id
            p_msg = (
                f"BRIDGE MISSING: window.OPENSWARM_APP not registered - "
                f"app '{p_oid}' is not agent-operable"
            )
            logger.error(f"[app-agent] {p_msg}")
            if os.environ.get("OPENSWARM_REQUIRE_BRIDGE") == "1":
                session.status = "completed"
                await ws_manager.send_to_session(session_id, "agent:status", {
                    "session_id": session_id, "status": "completed",
                    "session": session.model_dump(mode="json"),
                })
                return {
                    "session_id": session_id, "browser_id": browser_id,
                    "summary": f"This app is not agent-operable: {p_msg}.",
                    "done": True, "success": False,
                    "action_log": [], "final_screenshot": None,
                }
            app_front_load = (
                f"\n\n[{p_msg}. Operate it like a person instead: see with "
                "BrowserScreenshot, then play with BrowserPressKey (keys like "
                "w/a/s/d, arrows, Space, Enter) and BrowserClickPoint (tap a screen "
                "point). For a normal HTML app use BrowserListInteractives + "
                "BrowserClickIndex. Only give up (Done success=false) after you have "
                "actually tried pressing keys and nothing responds.]"
            )

    # Front-load perception (browser) or the app's controls (app mode) into the new task's user turn so the model can act immediately. Browser perception only attaches on a fresh conversation; app-mode controls attach on every task (see note above). The visible task text stays clean.
    p_front = app_front_load if app_mode else (preloaded_perception if not prior_messages else "")
    first_user_content = task + p_front if p_front else task
    messages: list[dict] = list(prior_messages) + [{"role": "user", "content": first_user_content}]
    # Seed with the front-loaded reads: they really ran and returned content, so a read task the agent answers straight from them is NOT a "did nothing" ghost.
    action_log: list[dict] = list(preloaded_reads)
    final_screenshot: str | None = None
    metrics_started_at = time.time()  # wall-clock start for per-task timing
    last_seen_url = initial_url or current_url or ""  # host source for skill record/replay

    # Loop detection state; sliding window of recent state-mutating tool calls
    recent_tool_calls: list[tuple[str, str, str]] = []
    loop_trigger_count = 0
    card_gone_streak = 0  # consecutive "card is gone" results -> fail fast, don't spin
    route_hinted_hosts: set[str] = set()  # surface the fast network tier once per host

    # Stagnation state: busy-but-stuck detection (no URL change + failures across a run of actions), distinct from the exact-repeat loop above.
    stagnation_streak = 0
    stagnation_prev_url = ""
    stagnation_prev_text = ""
    aux_adjudicated = False  # the one-shot stuck-adjudication fires at most once per run

    # Lazily-resolved cheap aux client, used only for the rare stuck-adjudication call once deterministic nudging is exhausted. Provider-agnostic.
    p_aux_state = {"resolved": False, "client": None, "model": None}

    async def p_get_aux_client():
        if not p_aux_state["resolved"]:
            p_aux_state["resolved"] = True
            try:
                # primary_api unlocks the registry's family-match + API-key branches; without it an OpenAI/Google key-only user gets a raise here and auto-scan + playbook learning silently die.
                aux_model, _ = await resolve_aux_model(
                    browser_settings, preferred_tier="haiku", primary_api=get_api_type(model),
                )
                p_aux_state["model"] = aux_model
                p_aux_state["client"] = get_anthropic_client_for_model(browser_settings, aux_model)
            except Exception as e:
                logger.warning(f"[browser-agent {session_id}] no aux model for adjudication: {e}")
        return p_aux_state["client"], p_aux_state["model"]

    latest_working_mem = ""  # most recent ReportProgress memory, for the tier-2 playbook distill

    # auto candidate scan: aux-read results pages so pick-a-candidate happens in the same turn as the landing, not a read-then-decide pair later
    auto_scanned_urls: set[str] = set()
    dismissed_popup_urls: set[str] = set()  # interstitials auto-closed, once per URL
    recovery_attaches = 0  # recoverable errors enriched with fresh state (saves a re-list turn)
    auto_scan_count = 0
    llm_ms_total = 0
    out_tokens_total = 0  # sum of per-turn output tokens (the latency driver)
    narration_turns = 0   # turns that emitted redundant prose next to an action

    async def p_scan_results(scan_for: str) -> tuple[str, int]:
        """Aux-model read of the current results page scored against the task.
        Returns (json_or_empty, elapsed_ms); fail-silent by design."""
        p_t0 = time.time()
        try:
            async def p_inner():
                page = await p_cancellable(execute_browser_tool("BrowserGetText", {}, browser_id, tab_id))
                if not isinstance(page, dict) or page.get("error") or not page.get("text"):
                    return ""
                aux_client, aux_model = await p_get_aux_client()
                # Cap the aux input to the top of the page: results pages put the matches first, and
                # feeding a huge LinkedIn/Amazon page to the aux was blowing the whole time budget so
                # the scan timed out with NOTHING (measured: 8001ms idle, empty). A head slice lets
                # the aux actually FINISH fast (useful hint) instead of stalling.
                return await browser_extract.extract_structured(
                    aux_client, aux_model, str(page["text"])[:P_SCAN_TEXT_CAP],
                    "These are search results. Identify which result(s) match this task: "
                    f"{scan_for[:400]}\nFor each plausible candidate give its exact displayed name, "
                    "the distinguishing details shown (role, company, location, etc), and why it "
                    "does or does not match. If none clearly match, say so in `best`.",
                    {"candidates": [{"name": "", "details": "", "match": ""}], "best": ""},
                )
            # Bail fast: a scan that can't produce a hint quickly is worse than none (the model reads
            # the page itself next turn anyway), so don't sit idle on it. 8s -> P_SCAN_TIMEOUT_S.
            out = await asyncio.wait_for(p_inner(), timeout=P_SCAN_TIMEOUT_S)
        except Exception:
            out = ""
        return out or "", int((time.time() - p_t0) * 1000)

    # Latest goal from ReportProgress; threaded into BrowserListInteractives so the frontend floats goal-matching elements to the top of the list. Seeded with the task so the first listing (before any ReportProgress) is boosted.
    current_next_goal = task

    # Advisory per-domain hints: seed the system prompt with what a prior agent learned about this domain (if we know the domain at start), and keep the store fresh from each ReportProgress. Re-verify, never blindly trust.
    start_domain = None if app_mode else (p_extract_domain(initial_url) if initial_url else None)
    run_system_prompt = APP_SYSTEM_PROMPT if app_mode else SYSTEM_PROMPT
    if start_domain:
        prior_note = browser_history.get_domain_note(start_domain)
        if prior_note:
            run_system_prompt = (
                SYSTEM_PROMPT
                + f"\n\n## Notes from a previous visit to {start_domain}\n"
                + "Learned last time on this site. Use it as a head start, but "
                + "re-verify since the page may have changed:\n"
                + prior_note
            )

    # Tier-2 memory: seed the DURABLE strategy playbook for this host (distilled from past successful runs) so the model skips re-discovery. Advisory text, re-verified by the agent, never auto-run. Keyed by full host like skills.
    pb_seeded = False  # whether tier-2 strategy was injected, for measuring its effect
    # Playbook key: web keys by site host; app mode keys by the stable app id (app:<output_id>). A no-bridge canvas app (Paint, Doom) has no URL host, so without this it re-discovers its own geography cold on every run; keying the durable playbook by browser_id lets that knowledge accumulate across runs.
    p_pb_host = browser_id if app_mode else browser_skills.host_of(initial_url or current_url or "")
    if p_pb_host:
        p_pb_block = browser_playbook.format_for_prompt(p_pb_host)
        if p_pb_block:
            run_system_prompt = run_system_prompt + p_pb_block
            pb_seeded = True
    # Tier-3 memory: cross-site priors learned on EVERY other site, injected on every web run (host-agnostic) so a brand-new site isn't fully cold. Web-only: generic site heuristics don't transfer to a bespoke app canvas.
    if not app_mode:
        try:
            p_meta_block = browser_meta_playbook.format_for_prompt()
            if p_meta_block:
                run_system_prompt = run_system_prompt + p_meta_block
        except Exception:
            pass

    # Prompt-caching shapes built once: system as a single cached text block, and the last tool carrying the cache_control marker (Anthropic keys on the trailing marker, so one marker covers the whole tool array + system).
    p_cached_system = [{
        "type": "text", "text": run_system_prompt,
        "cache_control": {"type": "ephemeral"},
    }]
    p_cached_tools = [dict(t) for t in (APP_VISIBLE_TOOLS if app_mode else browser_schema.MODEL_VISIBLE_TOOLS)]
    if p_cached_tools:
        p_cached_tools[-1] = {**p_cached_tools[-1], "cache_control": {"type": "ephemeral"}}

    user_msg = Message(role="user", content=task)
    session.messages.append(user_msg)
    await ws_manager.send_to_session(session_id, "agent:message", {
        "session_id": session_id,
        "message": user_msg.model_dump(mode="json"),
    })

    # Perceived value, zero clicks: one calm line so the user FEELS the agent is picking up where it left off. It claims "from a previous visit", so it must fire ONLY on a genuinely LEARNED playbook, never a shipped SEED (else a first-ever visit to any seeded popular site would lie about a visit that never happened). Seeds still inject their head-start into the prompt above; they just don't trigger this line.
    if p_pb_host and browser_playbook.load(p_pb_host):
        session.memory_recalled = True  # drives the subtle "Remembered" card chip
        p_where = "this app" if app_mode else p_pb_host
        p_recall_msg = Message(role="assistant",
                              content=f"Picking up what I learned about {p_where} from a previous visit.")
        session.messages.append(p_recall_msg)
        await ws_manager.send_to_session(session_id, "agent:message", {
            "session_id": session_id, "message": p_recall_msg.model_dump(mode="json"),
        })
        # Push the session so the "Remembered" chip shows WHILE it works (the high-value moment), not just on the finished card.
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id, "status": session.status,
            "session": session.model_dump(mode="json"),
        })

    async def p_cancellable(coro):
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

    # (skill_key_task derived earlier, above the prestage gate, so the skip check and this lookup share one key)

    # --- Fast path: replay a previously-learned skill with NO LLM round-trips. This is what gets a REPEAT task from ~50s (full agent loop) down to ~1s, i.e. faster than a human. Robust by construction: clicks re-resolve by (role,name), every step is verified, and ANY miss aborts to the full LLM agent below (which re-records), so a changed page can never ghost-succeed.
    replay_attempted = False

    # set by a prefix replay; appended to the first user message so the model wakes up at the composer instead of redoing the navigation
    replay_prefix_note = ""

    async def p_try_replay(host: str, turns_spent: int, allow_prefix: bool = False) -> dict | None:
        """Run a learned skill for the stable task key on `host` with zero LLM
        calls. Returns a completed-result dict on full success, or None to fall
        through to the LLM agent (no skill, unfillable slots, cancel, or any step
        miss). Updates skill trust on every attempt. Used at dispatch AND, when
        the card started on the wrong host, again after the first navigation
        lands us somewhere a skill exists (the deferred re-check). With
        allow_prefix, a send-gated skill replays its safe navigation prefix
        mechanically and hands the live agent just the irreversible tail."""
        nonlocal final_screenshot, last_seen_url, replay_attempted, replay_prefix_note
        nonlocal preloaded_perception, current_url
        if not host:
            return None

        async def p_exec_step(step: dict) -> dict | None:
            """One replay step; settle on the click target first so a recorded
            click never fires before the page paints it (the premature-click miss
            that quarantined skills), then an off-screen click gets one
            scroll-and-retry (recorded elements often sit below the fold)."""
            p_settle = browser_skills.replay_settle_target(step)
            if p_settle:
                async def p_w(t, p, b, tid):
                    return await p_cancellable(execute_browser_tool(t, p, b, tid))
                await browser_wait.smart_wait(p_w, browser_id, tab_id, 1500, until=p_settle)
            res = await p_cancellable(execute_browser_tool(step["tool"], step.get("params", {}), browser_id, tab_id))
            if res is not None and "box model" in str(res.get("error", "")):
                logger.info(f"[browser-skills] replay step off-screen ({step['tool']}); scrolling and retrying once")
                await p_cancellable(execute_browser_tool("BrowserScroll", {"direction": "down"}, browser_id, tab_id))
                retry = await p_cancellable(execute_browser_tool(step["tool"], step.get("params", {}), browser_id, tab_id))
                if retry is not None:
                    return retry
            return res

        sk_obj = browser_skills.find_skill(host, skill_key_task)
        steps = browser_skills.rehydrate(sk_obj, skill_key_task) if sk_obj else None
        if sk_obj and not steps:
            logger.info(f"[browser-skills] skill matched on {host} but slots unfillable from task; running full agent")
            return None
        if not (sk_obj and steps):
            logger.info(f"[browser-skills] no skill for host={host!r} after {turns_spent} turn(s)")
            return None
        # Audit finding: replay bypasses the per-tool gate and act-and-confirm, so a recorded Send/Submit must never re-fire silently. Those flows always run the live agent, which confirms before anything outward.
        unsafe_i, why = browser_skills.first_unsafe_step(steps)
        if unsafe_i >= 0:
            if not (allow_prefix and unsafe_i >= 1):
                logger.info(f"[browser-skills] skill on {host} not replayed: {why}; running the full agent so the send is confirmed")
                return None
            prefix = steps[:unsafe_i]
            # Marriage mode: the send-script owns the composer (it polls for the lazy overlay + fills + sends). Replaying a recorded composer-textbox click races that render and misses (v903/v906), so truncate the prefix to NAV + opener only and let the script take it from the navigated page. Keep >=1 step or there's nothing to replay.
            if os.environ.get("OSW_REPLAY_SENDTAIL", "0") == "1":
                p_nav_prefix = [s for s in prefix if not browser_skills.step_touches_composer(s)]
                if p_nav_prefix:
                    prefix = p_nav_prefix
            logger.info(
                f"[browser-skills] PREFIX replay: {len(prefix)}/{len(steps)} steps on {host}, "
                f"live agent confirms the tail ({why})"
            )
            p_pst = time.time()
            for step in prefix:
                if cancel_event.is_set():
                    return None
                st = time.time()
                res = await p_exec_step(step)
                if res is None:
                    return None
                el_ms = int((time.time() - st) * 1000)
                step_ok = "error" not in res
                browser_metrics.record_tool(
                    session_id, browser_id, -1, step["tool"], el_ms,
                    ok=step_ok, error=res.get("error", ""), is_loop=False,
                    stagnation_streak=0, result_len=len(str(res.get("text") or res.get("error") or "")),
                )
                logger.info(f"[browser-skills] prefix step {step['tool']} ok={step_ok} in {el_ms}ms")
                if not step_ok:
                    verdict = browser_skills.mark_replay_failed(host, skill_key_task)
                    logger.info(
                        f"[browser-skills] prefix step failed ({step['tool']}: {res.get('error')}); "
                        f"full agent from scratch (trust verdict: {verdict})"
                    )
                    return None
                # The end-of-run record_skill distills from action_log; without the replayed prefix in it, a warm run re-records a TAIL-ONLY skill (navigation missing) and clobbers the good one.
                action_log.append({
                    "tool": step["tool"], "input": step.get("params", {}), "ok": True,
                    "result_summary": str(res.get("text", ""))[:200], "elapsed_ms": el_ms,
                })
                if res.get("url"):
                    last_seen_url = res["url"]
            replay_attempted = True
            p_fresh = ""
            try:
                lst = await execute_browser_tool("BrowserListInteractives", {}, browser_id, tab_id)
                if isinstance(lst, dict) and lst.get("text") and "error" not in lst:
                    p_fresh = f"\nCurrent page state after the replayed prefix:\n{p_truncate_state(lst['text'])}"
                    # THE MARRIAGE (flag-gated): hand the post-prefix state to the verified send-script slot, the proven code tail (fill -> verify -> send -> two-sided receipt). A warm write then completes with ZERO model turns: replayed prefix + verified tail. Fail-open: if the script declines, the model gets the existing handoff note, today's behavior.
                    if os.environ.get("OSW_REPLAY_SENDTAIL", "0") == "1":
                        preloaded_perception = str(lst["text"])
                        if lst.get("url"):
                            current_url = str(lst["url"])
                        logger.info("[browser-skills] prefix handoff -> send-script slot armed (perception + url set)")
            except Exception:
                pass
            remaining = "; ".join(f"{s['tool']}({str(s.get('params', {}))[:80]})" for s in steps[unsafe_i:])
            replay_prefix_note = (
                f"\n\n[skill prefix replayed] A learned skill for this exact task already performed its "
                f"first {len(prefix)} step(s) mechanically in {int((time.time() - p_pst) * 1000)}ms; the page is now at "
                f"{last_seen_url or 'the prepared state'}. Recorded remaining step(s) for reference: {remaining}. "
                f"Finish from HERE (do not redo the navigation), and confirm the irreversible step with "
                f"expect proof as usual.{p_fresh}"
            )
            logger.info(f"[browser-skills] prefix handoff note attached ({len(replay_prefix_note)}ch)")
            return None
        replay_attempted = True
        logger.info(f"[browser-skills] REPLAY attempt: {len(steps)} steps on {host} (after {turns_spent} LLM turn(s))")
        rlog: list[dict] = []
        ok = True
        for step in steps:
            if cancel_event.is_set():
                return None
            st = time.time()
            res = await p_exec_step(step)
            if res is None:
                return None
            el_ms = int((time.time() - st) * 1000)
            step_ok = "error" not in res
            rlog.append({
                "tool": step["tool"], "input": step.get("params", {}),
                "result_summary": str(res.get("text", res.get("error", "")))[:200],
                "elapsed_ms": el_ms, "ok": step_ok,
            })
            browser_metrics.record_tool(
                session_id, browser_id, -1, step["tool"], el_ms,
                ok=step_ok, error=res.get("error", ""), is_loop=False,
                stagnation_streak=0, result_len=len(str(res.get("text") or res.get("error") or "")),
            )
            if not step_ok:
                logger.info(f"[browser-skills] replay step failed ({step['tool']}: {res.get('error')}), falling back to full agent")
                ok = False
                break
            if res.get("url"):
                last_seen_url = res["url"]
        if ok and rlog:
            browser_skills.mark_replay_succeeded(host, skill_key_task)
            summary = browser_metrics.record_task(
                session_id, browser_id, task, "completed", metrics_started_at,
                turns_spent, rlog, session.tokens,
                path="replay", task_sig=browser_skills.compute_sig(skill_key_task),
            )
            logger.info(f"[browser-skills] REPLAY SUCCEEDED in {summary['total_ms']}ms ({turns_spent} LLM turn(s))")
            try:
                ss = await execute_browser_tool("BrowserScreenshot", {}, browser_id, tab_id)
                if ss.get("image"):
                    final_screenshot = ss["image"]
            except Exception:
                pass
            session.status = "completed"
            await ws_manager.send_to_session(session_id, "agent:status", {
                "session_id": session_id, "status": "completed",
                "session": session.model_dump(mode="json"),
            })
            return {
                "session_id": session_id, "browser_id": browser_id,
                # Clean human confirmation, never the replay mechanics ('skill replay / N steps / no LLM'); `done` is the structured success signal the parent reads instead of grepping for a tag.
                "summary": "Done, I took care of that for you.",
                "done": True,
                "action_log": rlog, "final_screenshot": final_screenshot,
                "replayed": True,
            }
        # Replay didn't fully succeed. Update the skill's trust: an unproven skill that failed gets quarantined (never replayed again -> pure-LLM baseline), a proven one tolerates a transient miss. The full agent re-records edit- aware (new steps -> new rev).
        if not cancel_event.is_set():
            verdict = browser_skills.mark_replay_failed(host, skill_key_task)
            logger.info(f"[browser-skills] replay fell back to full agent (trust verdict: {verdict})")
        return None

    replay_host = browser_skills.host_of(initial_url) if initial_url else ""
    if not replay_host and current_url:
        replay_host = browser_skills.host_of(current_url)  # live URL of an existing card
    if not replay_host:
        m = re.search(r"https?://\S+", task)
        if m:
            replay_host = browser_skills.host_of(m.group(0))
    # The card might have started on the WRONG host (the orchestrator often opens a fresh card on google and only navigates to the target later); if so, this dispatch check misses and the deferred re-check inside the loop catches it after the first navigation.
    replay_rechecked = False
    logger.info(f"[browser-skills] dispatch replay check: host={replay_host!r}")
    p_dispatch_replay = await p_try_replay(replay_host, 0, allow_prefix=True)
    if p_dispatch_replay is not None:
        return p_dispatch_replay
    if replay_prefix_note:
        messages[-1]["content"] = f"{messages[-1]['content']}{replay_prefix_note}"

    # Route hint: replay declined (send-gated, no exact key, or different wording), but a similar verified route may exist; hand it to the model as advisory text so it follows a known path instead of re-exploring.
    route_hint_keys: list[tuple] = []
    if not replay_prefix_note:
        p_h_skill, p_h_score = browser_skills.find_similar_skill(replay_host, skill_key_task)
        if p_h_skill:
            p_hint, route_hint_keys = browser_skills.render_route_hint(p_h_skill, skill_key_task, p_h_score)
            if p_hint:
                messages[-1]["content"] = f"{messages[-1]['content']}{p_hint}"
                logger.info(
                    f"[browser-route {session_id}] hint attached at dispatch: host={replay_host} "
                    f"sim={p_h_score:.2f} steps={len(route_hint_keys)} state={p_h_skill.get('state')}"
                )

    task_is_send = not deliverable_is_informational("", task)
    # Pre-nav landed on a results page (the cold entry case): scan it NOW so the model's very first turn can pick a candidate instead of read-then-decide. SKIP it for a SEND task: sending (message a person, reply to a post) clicks through to a composer, it never picks from a ranked candidate list, so the scan is a ~4s blocking aux call for nothing on the exact path we most want instant.
    p_start_url = (current_url or initial_url or "").split("#")[0]
    if p_start_url and RESULTS_URL_RE.search(p_start_url) and not task_is_send:
        auto_scanned_urls.add(p_start_url)
        p_scan_json, p_sc_ms = await p_scan_results(task)
        if p_scan_json:
            auto_scan_count += 1
            messages[-1]["content"] = (
                f"{messages[-1]['content']}\n\n[auto candidate scan] An assistant model read "
                f"this results page against the task:\n{p_scan_json}\n"
                "Treat it as a hint; verify on the page before acting."
            )
            action_log.append({
                "tool": "BrowserExtract", "input": {"instruction": "(auto candidate scan)"},
                "result_summary": p_scan_json[:200], "elapsed_ms": p_sc_ms, "ok": True,
            })
            logger.info(
                f"[browser-cold {session_id}] dispatch candidate scan on {p_start_url[:90]} "
                f"in {p_sc_ms}ms ({len(p_scan_json)}ch)"
            )
        else:
            logger.info(
                f"[browser-cold {session_id}] dispatch candidate scan empty on "
                f"{p_start_url[:90]} after {p_sc_ms}ms"
            )

    text_parts = []  # initialized before loop so post-loop summary (line ~1294) has a default
    rp_violations = 0  # turns the model acted without ReportProgress (now accepted + reminded, not rejected)
    # The model finishes by calling the Done tool; `message` is the clean human reply, `success` whether the goal was met. Falls back to terminal text on the rare run that stops without calling Done.
    done_called = False
    done_message = ""
    done_success = True
    done_keep_open = False
    # Completion detection uses task_is_send (computed above, before the candidate scan): once an irreversible SEND has confirmed, the goal is met. The model otherwise stalls re-verifying what the confirm already proved (measured: send done at turn ~11, then ~12 wasted perception turns). We drive it to the OUTCOME and, if it keeps re-perceiving, end the run. A genuine multi-send task issues its NEXT send (an action) which resets the stall, so only true spinning ends here. Meaningless for a gather/read task, and arming it there let a cookie 'Accept all' click masquerade as the task's send, so we gate it on intent.
    send_confirmed = False
    # Two-sided receipt evidence: the fill must have VISIBLY committed its text to a textbox before a send-class click may end the run in code. r228 clicked a send-labeled control after an uncommitted fill and the old click-name-only receipt claimed a send that never happened.
    composer_committed_payload = ""
    perception_stall = 0           # consecutive turns the model only LOOKED (no action)
    P_POST_SEND_STALL_LIMIT = 2     # once the send registered, finish fast
    P_PERCEPTION_STALL_LIMIT = 6    # backstop when we couldn't detect the send (e.g. Enter): bound the spin
    # When the spin backstop trips we don't guillotine the run (that leaks the model's half-finished sentence as the reply). We nudge it to wrap up ONCE, so it summarizes what it has via Done; a second trip then stops for real.
    wrapup_nudged = False
    # Distinct read results seen, so the backstop tells a productive page-by-page gather (new data each turn) from genuine spinning (re-reading the same thing).
    seen_read_sigs: set[str] = set()
    # rows already shown to the model; attached state shrinks to the delta
    attached_state_seen: set[str] = set()
    # under-batching telemetry + nudge state
    single_action_streak = 0
    batching_nudges = 0
    redundant_read_nudges = 0
    # True after a mutating action attaches fresh state; a solo read next is waste
    fresh_state_pending = False
    multi_action_turns = 0
    batch_calls = 0
    batch_guard_blocks = 0

    # Staged-send script: prestage left a ready composer + the task quotes its payload -> code runs the fill/verify/send/verify tail the model spends 4-5 turns on. Success skips the loop entirely (turns=0); any pre-click ambiguity falls through untouched.
    from backend.apps.agents.browser import browser_send_script
    p_script = None
    if (browser_send_script.script_enabled() and task_is_send and not app_mode
            and preloaded_perception and not cancel_event.is_set()):
        try:
            p_script = await asyncio.wait_for(browser_send_script.run_send_script(
                task, browser_id, tab_id, preloaded_perception,
                execute_browser_tool, send_submit_index_in_state, payload_in_textbox,
                payload_source=user_prompt, current_url=current_url,
            ), timeout=30.0)
        except Exception as p_se:
            logger.info(f"[browser-sendscript] outer skip ({p_se})")
            p_script = None
        if isinstance(p_script, dict):
            action_log.extend(p_script["log"])
            if p_script["sent"]:
                # receipt verified (composer cleared): the send is DONE, end the run
                send_confirmed = True
                done_called = True
                done_success = True
                p_aux_c, p_aux_m = await p_get_aux_client()
                done_message = (await compose_send_confirmation(p_aux_c, p_aux_m, task, p_script["payload"])
                                or f'Done, I sent "{p_script["payload"]}" for you.')
            else:
                # Clicked but the composer did NOT clear: the send is UNVERIFIED. Leave send_confirmed False so the loop can't shortcut to a "done" it never earned (r264 set it True here and the model then FALSELY claimed delivery). The model gets ONE truthful verify pass, never a blind resend.
                task = f"{task}\n\n[{p_script['note']}]"

    # Dry-run is a measurement mode, so the run ENDS here either way: letting the model loop run would both risk the REAL send the flag exists to avoid and rescue declines the flag exists to attribute. Inert when the flag is off.
    if os.environ.get("OSW_SENDSCRIPT_DRYRUN") == "1" and not done_called:
        p_dr = browser_send_script.dryrun_report(
            preloaded_perception or "", bool(task_is_send and preloaded_perception),
            isinstance(p_script, dict), current_url)
        logger.info(p_dr)
        done_called = True
        done_success = True
        done_message = ("DRY-RUN coverage probe: no send was performed and none should be "
                        "retried; report this outcome verbatim. " + p_dr)

    # Code-side plan dispatch (the turn-collapser that doesn't wait for the model to adopt a tool): one aux call compiles the task's mechanical prefix into verified steps, code executes them, and the big model starts with that work DONE. Fail-open: no plan/steps = today's loop untouched.
    # A send task whose composer is ALREADY staged has no mechanical prefix left (the model's one fill turn + autosend own the rest), so skip the aux call instead of letting it poke the composer (measured 4.7s of nothing).
    from backend.apps.agents.browser import browser_plan_dispatch
    p_composer_staged = bool(task_is_send and browser_send_script.composer_index_in_state(preloaded_perception or ""))
    if (browser_plan_dispatch.plan_dispatch_enabled() and not app_mode and not done_called
            and preloaded_perception and not p_composer_staged and not cancel_event.is_set()):
        try:
            p_plan_note = await asyncio.wait_for(browser_plan_dispatch.run_plan_dispatch(
                task, preloaded_perception, browser_id, tab_id,
                load_settings(), get_api_type(model), execute_browser_tool,
            ), timeout=45.0)
        except Exception as p_pe:
            logger.info(f"[plan-dispatch] outer skip ({p_pe})")
            p_plan_note = ""
        if p_plan_note:
            task = f"{task}\n\n{p_plan_note}"

    try:
        for turn in range(MAX_TURNS):
            if done_called or cancel_event.is_set():
                break

            # Drop stale screenshots before each call: keep first + previous + current, stub the rest. Images are ~1.3-2k tokens each and get re-read every turn, so this is the biggest per-turn context win on any visual task (measured ~2.9x fewer image tokens, ~5x less upload).
            browser_history.prune_old_screenshots(messages)
            browser_history.prune_stale_page_state(messages)
            browser_history.place_cache_marker(messages)
            p_llm_t0 = time.monotonic()

            # STREAM, don't .create(): 9Router returns non-Anthropic lanes (Gemini/OpenRouter/Antigravity) as a REAL multi-event SSE stream that the non-streaming client parses to empty content, silently breaking tool-use on every non-Claude provider (measured: only cc/ emitted tool_use before this). The streaming parser reconstructs tool_use identically for ALL providers, so this is the model-independence fix, not a UX tweak. Cache marker still rides p_cached_system (Anthropic keys on it; other routes ignore it harmlessly).
            async def p_stream_turn():
                async with client.messages.stream(
                    model=api_model,
                    max_tokens=4096,
                    system=p_cached_system,
                    tools=p_cached_tools,
                    messages=messages,
                ) as p_s:
                    return await p_s.get_final_message()
            response = await p_cancellable(p_stream_turn())
            if response is None:
                break
            p_llm_ms = int((time.monotonic() - p_llm_t0) * 1000)
            llm_ms_total += p_llm_ms
            # Guard against empty content (e.g. upstream API error from 9Router that the SDK parsed into a partial response object).
            if not response.content:
                logger.warning(f"Browser agent {session_id}: empty response content from {api_model}")
                break

            # Track token usage from browser agent API calls
            if hasattr(response, 'usage') and response.usage:
                p_out = response.usage.output_tokens or 0
                p_in = response.usage.input_tokens or 0
                out_tokens_total += p_out
                session.tokens["input"] = session.tokens.get("input", 0) + p_in
                # Already-uncached here (cache tracked separately below), so the fresh lane that feeds the parent's pill mirrors it 1:1.
                session.tokens["input_fresh"] = session.tokens.get("input_fresh", 0) + p_in
                session.tokens["output"] = session.tokens.get("output", 0) + p_out
                p_cr = getattr(response.usage, "cache_read_input_tokens", 0) or 0
                p_cw = getattr(response.usage, "cache_creation_input_tokens", 0) or 0
                if p_cr:
                    session.tokens["cache_read"] = session.tokens.get("cache_read", 0) + p_cr
                # Per-turn OUTPUT tokens are the latency driver (generation is serial, input is cached), so log every turn: this is how we verify the plan- once/terse-execution prompt actually shrinks per-turn output live.
                logger.info(f"[browser-tokens] turn={turn} out={p_out} in={p_in} cache_read={p_cr} cache_write={p_cw} llm_ms={p_llm_ms}")

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

            # think-shorter telemetry: a turn that emits BOTH prose and an action tool is the redundant narration the prompt now forbids; count it so the bench can verify the prose actually went away.
            if any(t.strip() for t in text_parts) and any(
                tu.name in ACTION_TOOLS_REQUIRING_REPORT for tu in tool_uses
            ):
                narration_turns += 1

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
            wrapup_pending = False  # set when the spin backstop wants to nudge this turn

            # Sort tool_uses so ReportProgress is always processed first within a turn, even if the model emits it after action tools. This way the brain state is recorded before any actions execute.
            has_report_progress = any(tu.name == "ReportProgress" for tu in tool_uses)
            has_action_tools = any(
                tu.name in ACTION_TOOLS_REQUIRING_REPORT for tu in tool_uses
            )
            # Violation: action tools without ReportProgress in the same turn. The model MUST articulate its evaluation/memory/goal before acting. Acted without the ReportProgress preamble. Do NOT reject and burn the turn (measured 5/28 turns lost to this on one run): ReportProgress is a reflection/UX aid, NOT a safety gate (the send-guard, completion gate and act-and-confirm are separate and untouched). Let the action run, synthesize a minimal goal so the UX card + tracking aren't blank, and remind once on the result. Genuine runaway is still caught by the loop detector and MAX_TURNS, which is what actually bounds a loop.
            report_progress_violation = has_action_tools and not has_report_progress
            rp_reminder_pending = False
            if report_progress_violation:
                rp_violations += 1
                rp_reminder_pending = True
                if not current_next_goal or current_next_goal == task:
                    p_synth = next((t.name for t in tool_uses if t.name in ACTION_TOOLS_REQUIRING_REPORT), "act")
                    current_next_goal = f"(continuing) {p_synth.replace('Browser', '').lower()}"
                logger.info(
                    f"[browser-agent {session_id}] ReportProgress omitted; running the action "
                    f"anyway and reminding (rp_violations={rp_violations})"
                )
            # Stable sort: ReportProgress first, then everything else in order.
            tool_uses_sorted = sorted(
                tool_uses,
                key=lambda t: 0 if t.name == "ReportProgress" else 1,
            )

            # Under-batching detector: the model ignores prompt-level batching invitations, so measure each turn and nudge mechanically below.
            p_turn_actions = sum(1 for t in tool_uses_sorted if t.name in P_BATCHABLE_ACTION_TOOLS)
            p_turn_has_batch = any(t.name in ("BrowserBatch", "BrowserRepeatFlow") for t in tool_uses_sorted)
            if p_turn_actions >= 2 or p_turn_has_batch:
                multi_action_turns += 1
                single_action_streak = 0
                if p_turn_has_batch:
                    batch_calls += 1
            elif p_turn_actions == 1:
                single_action_streak += 1
            logger.info(
                f"[browser-batching {session_id}] turn={turn} actions={p_turn_actions} "
                f"batch={p_turn_has_batch} streak={single_action_streak}"
            )

            # Progress = an action OR a read that returned content we haven't seen. A page-by-page gather (a fresh BrowserExtract each turn) is real progress, not spinning, so detecting new data here keeps the backstop from cutting it off with partial results. Re-reading the same page yields no new sig.
            p_novel_read = False
            for p_a in action_log:
                if (p_a.get("ok") and p_a.get("tool") not in P_BATCHABLE_ACTION_TOOLS
                        and p_a.get("tool") not in ("ReportProgress", "Done")):
                    p_sig = f"{p_a.get('tool')}:{p_a.get('result_summary') or ''}"
                    if p_sig not in seen_read_sigs:
                        seen_read_sigs.add(p_sig)
                        p_novel_read = True

            # Out of turn budget with no answer yet: nudge a wrap-up so a long-running gather delivers what it has via Done at the cap, instead of the for-loop ending on the model's half-finished sentence. Same one-shot channel.
            if turn >= MAX_TURNS - 4 and not wrapup_nudged and not done_called and not send_confirmed:
                wrapup_nudged = True
                wrapup_pending = True
                logger.info(f"[browser-agent {session_id}] turn budget low ({turn}/{MAX_TURNS}); nudging wrap-up")

            # Spin backstop: a pure-perception turn that ISN'T gathering new data is wasted (re-verifying a send, or re-looking at the same page). Bound it.
            if p_turn_actions == 0:
                # gather tasks: new content IS the work, so it resets the stall. After a send confirmed, re-reading is just re-verification, never progress.
                if p_novel_read and not send_confirmed:
                    perception_stall = 0
                else:
                    perception_stall += 1
                    # The general backstop only applies AFTER the agent has actually done something; early pure-perception is legitimate orienting on a cold/slow page, which we must never cut short.
                    p_acted = any(a.get("ok") and a.get("tool") in (P_BATCHABLE_ACTION_TOOLS | {"BrowserBatch"})
                                 for a in action_log)
                    p_stall_limit = (P_POST_SEND_STALL_LIMIT if send_confirmed
                                    else (P_PERCEPTION_STALL_LIMIT if p_acted else 10 ** 9))
                    if perception_stall >= p_stall_limit:
                        if send_confirmed:
                            # the send registered: hand the parent a real done. The raw action-log proof (indices/coords) is machine-speak, kept out.
                            done_called = True
                            done_message = "All set, your message went through and it's showing in the conversation now."
                            logger.info(f"[browser-agent {session_id}] ending: {perception_stall} post-send perception turns")
                            break
                        if not wrapup_nudged:
                            # don't cut it off mid-thought: ride a wrap-up nudge out on this turn's tool_results so next turn it answers via Done.
                            wrapup_nudged = True
                            wrapup_pending = True
                            perception_stall = 0
                            logger.info(f"[browser-agent {session_id}] spin backstop: nudging to wrap up via Done")
                        else:
                            # Nudge already spent and still looping: stop on a clean line.
                            logger.info(f"[browser-agent {session_id}] ending: wrap-up nudge ignored, stopping")
                            if not done_called:
                                done_called = True
                                done_message = "That's as far as I could get gathering this one."
                            break
            else:
                perception_stall = 0

            for tu in tool_uses_sorted:
                if cancel_event.is_set():
                    cancelled = True
                    break

                # Handle ReportProgress; no-op execution that just records the model's brain state and streams it to the dashboard.
                if tu.name == "ReportProgress":
                    eval_prev = tu.input.get("evaluation_previous", "")
                    working_mem = tu.input.get("working_memory", "")
                    next_goal = tu.input.get("next_goal", "")
                    if next_goal:
                        current_next_goal = next_goal
                    if working_mem:
                        latest_working_mem = working_mem  # for the tier-2 playbook distill at the end
                    # Distill the agent's own working memory into a per-domain hint for the next visit. Only persist when the run stayed on a SINGLE apex domain: working_memory is cumulative, so on a multi-domain run it would describe one site but get filed under whichever domain happens to be current.
                    note_domain = (
                        session.browser_domains[-1]
                        if session.browser_domains
                        else start_domain
                    )
                    single_domain = len(set(session.browser_domains)) <= 1
                    if note_domain and working_mem and single_domain:
                        browser_history.set_domain_note(note_domain, working_mem)
                    brain_text = (
                        f"📋 **Plan**\n"
                        + (f"_Previous_: {eval_prev}\n" if eval_prev else "")
                        + f"_Memory_: {working_mem}\n"
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

                # Skill self-awareness (backend-inline; the skill store is here, not in the webview). The agent can inspect what shortcuts it has for this site and prune stale ones. Kept off the LLM context by default (it's a tool the agent calls only when it wants).
                if tu.name in ("BrowserListSkills", "BrowserDeprecateSkill"):
                    cur_host = browser_skills.host_of(last_seen_url) or replay_host
                    if tu.name == "BrowserListSkills":
                        skills = browser_skills.list_skills(cur_host) if cur_host else []
                        playbook = browser_playbook.get_playbook(cur_host) if cur_host else []
                        parts = []
                        if skills:
                            p_tag = {"trusted": "proven", "probation": "unproven", "quarantine": "disabled"}
                            def p_fmt_skill(s):
                                line = f"- \"{s['task']}\" ({s['steps']} steps, {p_tag.get(s['state'], s['state'])}, reused {s['replays']}x"
                                if s.get("builds_on"):
                                    line += f", builds on {len(s['builds_on'])} other shortcut(s)"
                                return line + ")"
                            parts.append(f"Learned shortcuts for {cur_host}:\n" + "\n".join(p_fmt_skill(s) for s in skills[:20]))
                        if playbook:
                            parts.append(f"Strategy I've learned about {cur_host}:\n" + "\n".join(f"- {b}" for b in playbook))
                        meta_text = "\n\n".join(parts) if parts else f"Nothing learned for {cur_host or 'this site'} yet."
                    else:
                        target = tu.input.get("task", "")
                        ok = browser_skills.deprecate_skill(cur_host, target) if cur_host else False
                        meta_text = (f"Removed the stale shortcut \"{target}\"; it'll be re-learned next time you do it."
                                     if ok else f"No matching shortcut \"{target}\" found to remove.")
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": [{"type": "text", "text": meta_text}]})
                    result_msg = Message(role="tool_result", content={"text": meta_text, "tool_name": tu.name, "elapsed_ms": 0})
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id, "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                # Schema extract (backend-inline): the aux model reads the page text so the main model gets just the JSON it asked for, never the 15k raw chars. Read-only; falls back honest on any miss.
                if tu.name == "BrowserExtract":
                    instruction = str(tu.input.get("instruction", "")).strip()
                    st = time.time()
                    ex_ok = False
                    if not instruction:
                        ex_text = "BrowserExtract needs an instruction saying what to pull from the page."
                    else:
                        page = await p_cancellable(execute_browser_tool("BrowserGetText", {}, browser_id, tab_id))
                        if page is None:
                            ex_text = "Cancelled."
                        elif page.get("error"):
                            ex_text = f"Could not read the page: {page['error']}"
                        else:
                            if page.get("url"):
                                last_seen_url = page["url"]
                            aux_client, aux_model = await p_get_aux_client()
                            data = await browser_extract.extract_structured(
                                aux_client, aux_model, str(page.get("text", "")),
                                instruction, tu.input.get("schema"),
                            )
                            ex_text = data or (
                                "Extraction unavailable right now; use BrowserGetText and read the page yourself."
                            )
                            ex_ok = bool(data)
                    # every attempt is logged (the completion gate cross-examines this; a successful extract IS the productive read of a task)
                    action_log.append({
                        "tool": "BrowserExtract", "input": {"instruction": instruction[:200]},
                        "result_summary": ex_text[:200],
                        "elapsed_ms": int((time.time() - st) * 1000), "ok": ex_ok,
                    })
                    browser_metrics.record_tool(
                        session_id, browser_id, turn, "BrowserExtract",
                        int((time.time() - st) * 1000), ok=ex_ok,
                        error="" if ex_ok else ex_text[:160], is_loop=False,
                        stagnation_streak=0, result_len=len(ex_text),
                    )
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": [{"type": "text", "text": ex_text}]})
                    result_msg = Message(role="tool_result", content={"text": ex_text, "tool_name": tu.name, "elapsed_ms": 0})
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id, "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                # Bulk-data sink: write a page-assembled dataset straight to a file so a big list never has to squeeze through the (truncating) reply. The JS runs in the page, but Python picks the path, so the write stays sandboxed.
                if tu.name == "BrowserSaveData":
                    st = time.time()
                    p_expr = tu.input.get("expression") or ""
                    p_fname = tu.input.get("filename") or ""
                    if not p_expr:
                        sv_text, sv_ok = "BrowserSaveData needs a JS `expression` that returns the data (usually JSON.stringify(...)).", False
                    else:
                        p_ev = await p_cancellable(execute_browser_tool("BrowserEvaluate", {"expression": p_expr}, browser_id, tab_id))
                        if p_ev is None:
                            cancelled = True
                            break
                        if isinstance(p_ev, dict) and p_ev.get("error"):
                            sv_text, sv_ok = f"Couldn't read the data to save: {p_ev['error']}", False
                        else:
                            p_cwd = None
                            if parent_session_id:
                                p_ps = agent_manager.get_session(parent_session_id)
                                p_cwd = getattr(p_ps, "cwd", None) if p_ps else None
                            sv_text = browser_save.save_page_data(
                                p_cwd, parent_session_id or session_id, p_fname, str((p_ev or {}).get("text") or ""))
                            sv_ok = sv_text.startswith("Saved")
                    action_log.append({
                        "tool": "BrowserSaveData", "input": {"filename": p_fname},
                        "result_summary": sv_text[:200],
                        "elapsed_ms": int((time.time() - st) * 1000), "ok": sv_ok,
                    })
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": [{"type": "text", "text": sv_text}]})
                    result_msg = Message(role="tool_result", content={"text": sv_text, "tool_name": tu.name, "elapsed_ms": int((time.time() - st) * 1000)})
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id, "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                # Intra-run batch replay: run a learned mechanical flow for many inputs at machine speed, verify every step, gate sends, never ghost. Reads/searches loop freely; irreversible steps refuse.
                if tu.name == "BrowserActVerified":
                    from backend.apps.agents.browser import browser_verified_step
                    from backend.apps.agents.browser.browser_prestage import P_BLOCKED_CLICK_RE
                    p_steps_in = tu.input.get("steps") or []
                    p_step_lines: list[str] = []
                    p_all_ok = True
                    if not p_steps_in:
                        p_va_text = "No steps given; nothing to do."
                    else:
                        for p_si, p_raw in enumerate(p_steps_in[:4], start=1):
                            p_tgt = str((p_raw or {}).get("target") or "")
                            # the solo-send rule holds here in CODE: an irreversible-smelling target is refused, exactly like a batch
                            if P_BLOCKED_CLICK_RE.search(p_tgt):
                                p_step_lines.append(f"{p_si}. REFUSED: {p_tgt!r} looks irreversible; do it as a SOLO click with an `expect` proof.")
                                p_all_ok = False
                                break
                            p_vstep = browser_verified_step.VerifiedStep(
                                kind=str(p_raw.get("action") or "click"), target=p_tgt,
                                role=str(p_raw.get("role") or ""), text=str(p_raw.get("text") or ""),
                                expect=str(p_raw.get("expect") or ""))
                            p_st = time.time()
                            p_vr = await p_cancellable(browser_verified_step.run_verified_step(
                                p_vstep, browser_id, tab_id, execute_browser_tool))
                            if p_vr is None:
                                p_step_lines.append(f"{p_si}. cancelled"); p_all_ok = False; break
                            p_el = int((time.time() - p_st) * 1000)
                            action_log.append({
                                "tool": "BrowserActVerified", "input": p_raw, "ok": p_vr["ok"],
                                "result_summary": (f"{p_vstep.kind} {p_tgt!r} verified" if p_vr["ok"]
                                                   else str(p_vr["note"]))[:200],
                                "elapsed_ms": p_el,
                            })
                            browser_metrics.record_tool(
                                session_id, browser_id, turn, "BrowserActVerified", p_el, ok=p_vr["ok"],
                                error="" if p_vr["ok"] else str(p_vr["note"]), is_loop=False,
                                stagnation_streak=0, result_len=0)
                            if p_vr["ok"]:
                                p_step_lines.append(f"{p_si}. {p_vstep.kind} {p_tgt!r}: OK (verified)")
                            else:
                                p_step_lines.append(f"{p_si}. {p_vstep.kind} {p_tgt!r}: FAILED ({p_vr['note']}); remaining steps skipped")
                                p_all_ok = False
                                break
                        p_va_text = ("All steps verified:\n" if p_all_ok else "Stopped early:\n") + "\n".join(p_step_lines)
                        # fold the post-plan page state in so the model's next turn already sees the result
                        p_va_state = await post_action_state(
                            "BrowserBatch", {}, {"ok": True}, browser_id, tab_id,
                            wait_exec=execute_browser_tool, goal=current_next_goal or "",
                            seen_lines=attached_state_seen)
                        if p_va_state:
                            p_va_text += p_va_state
                            fresh_state_pending = True
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": [{"type": "text", "text": p_va_text}]})
                    result_msg = Message(role="tool_result", content={"text": p_va_text, "tool_name": tu.name, "elapsed_ms": 0})
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id, "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                if tu.name == "BrowserRepeatFlow":
                    steps_tmpl = tu.input.get("steps") or []
                    values = [str(v) for v in (tu.input.get("values") or [])]
                    ok_struct, why = browser_batch_replay.validate_template(steps_tmpl)
                    safe, safe_why = (browser_batch_replay.template_safety(steps_tmpl) if ok_struct else (False, why))
                    if not ok_struct:
                        bf_text = f"Couldn't run the batch: {why}."
                    elif not safe:
                        bf_text = (f"Refused to auto-repeat this flow: {safe_why}. "
                                   "Do those steps one at a time so each is confirmed.")
                    elif not values:
                        bf_text = "No values to repeat; nothing to do."
                    else:
                        records = []  # {value, ok, text} per item, for the data return
                        for val in values:
                            if cancel_event.is_set():
                                break
                            item_ok = True
                            item_text = ""
                            for tool_name, params in browser_batch_replay.fill_template(steps_tmpl, val):
                                st = time.time()
                                res = await p_cancellable(execute_browser_tool(tool_name, params, browser_id, tab_id))
                                if res is None:
                                    item_ok = False; item_text = "cancelled"; break
                                el = int((time.time() - st) * 1000)
                                step_ok = "error" not in res
                                # carry each step's output; the LAST read step's text is the data the agent wanted from this item.
                                if step_ok and res.get("text"):
                                    item_text = str(res["text"])
                                action_log.append({
                                    "tool": tool_name, "input": params,
                                    "result_summary": str(res.get("text", res.get("error", "")))[:200],
                                    "elapsed_ms": el, "ok": step_ok,
                                })
                                browser_metrics.record_tool(
                                    session_id, browser_id, turn, tool_name, el, ok=step_ok,
                                    error=res.get("error", ""), is_loop=False, stagnation_streak=0,
                                    result_len=len(str(res.get("text") or res.get("error") or "")),
                                )
                                if res.get("url"):
                                    last_seen_url = res["url"]
                                if not step_ok:
                                    item_ok = False
                                    item_text = str(res.get("error") or "did not match the template")
                                    break
                            records.append({"value": val, "ok": item_ok, "text": item_text})
                        bf_text = browser_batch_replay.summarize_batch(
                            records, browser_batch_replay.is_readonly_template(steps_tmpl),
                        )
                    tool_results.append({"type": "tool_result", "tool_use_id": tu.id, "content": [{"type": "text", "text": bf_text}]})
                    result_msg = Message(role="tool_result", content={"text": bf_text, "tool_name": tu.name, "elapsed_ms": 0})
                    session.messages.append(result_msg)
                    await ws_manager.send_to_session(session_id, "agent:message", {
                        "session_id": session_id, "message": result_msg.model_dump(mode="json"),
                    })
                    continue

                # Handle Done: the model's typed-field finish. The `message` is the clean human reply (no OUTCOME tag, no UI mechanics), so it goes to the user as-is. Add its tool_result here (the post-loop integrity backfill pairs the rest + appends), set the flag, and break; the outer loop exits on done_called right after.
                if tu.name == "Done":
                    done_called = True
                    done_message = (tu.input.get("message") or "").strip()
                    done_success = tu.input.get("success", True) is not False
                    done_keep_open = tu.input.get("keep_open", False) is True
                    tool_results.append({
                        "type": "tool_result", "tool_use_id": tu.id,
                        "content": [{"type": "text", "text": "ok"}],
                    })
                    break

                # Handle RequestHumanIntervention; pause and wait for user
                if tu.name == "RequestHumanIntervention":
                    problem = tu.input.get("problem", "")
                    instruction = tu.input.get("instruction", "")
                    decision = await p_request_browser_approval(
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

                policy = p_browser_perms.get(tu.name, "always_allow")

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
                    decision = await p_request_browser_approval(
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
                # did the PREVIOUS action already hand us fresh page state? a solo re-read now is a wasted round-trip; remembered before we overwrite it
                p_had_fresh_state = fresh_state_pending
                tool_input = tu.input
                if tu.name == "BrowserListInteractives" and current_next_goal:
                    tool_input = {**tu.input, "goal": current_next_goal}

                async def p_wait_exec(tool, params, bid, tid):
                    return await p_cancellable(execute_browser_tool(tool, params, bid, tid))

                # Hard send-guard: an irreversible step physically cannot ride in a batch (the solo-send rule was prompt-only before; prompts drift).
                p_guard_why = (browser_batch_replay.live_batch_guard(
                    (tool_input or {}).get("actions"), attached_state_seen,
                    composer_pending=bool(browser_batch_replay.send_payload_from_log(action_log)))
                    if tu.name == "BrowserBatch" else "")
                if p_guard_why:
                    batch_guard_blocks += 1
                    logger.info(
                        f"[browser-batch-guard {session_id}] blocked batch at turn {turn}: {p_guard_why}"
                    )
                    result = {"error": (
                        f"BATCH BLOCKED, nothing was executed: {p_guard_why}. Irreversible "
                        "steps (Send/Submit/Pay/Post/Connect class) never ride in a batch: "
                        "do that step SOLO with BrowserClickIndex + `expect` proof, and "
                        "batch only the routine steps around it."
                    )}
                elif tu.name == "BrowserApiWrite":
                    # API-first write tier: the site's own write API via the borrowed session, deterministic + a real receipt. A miss is a typed "use the UI" (never a crash), so the loop falls back cleanly.
                    result = await p_cancellable(run_api_write(tu.input, current_url, browser_id, tab_id))
                    if result is None:
                        cancelled = True
                        break
                elif tu.name == "BrowserWait":
                    # Smart wait: return as soon as the page is ready (target or DOM settle), not on a blind timer (the audit's 42%-of-time hog).
                    result = await browser_wait.smart_wait(
                        p_wait_exec, browser_id, tab_id, tu.input.get("milliseconds"),
                        until=(tu.input.get("until") or ""),
                    )
                else:
                    result = await p_cancellable(execute_browser_tool(
                        tu.name, tool_input, browser_id, tab_id,
                    ))
                if result is None:
                    cancelled = True
                    break
                elapsed_ms = int((time.time() - start) * 1000)

                # An API-first write that returned ok carries its own typed receipt, so it IS the confirmation: mark the send done so the loop drives to Done without a redundant UI re-verify (and never re-fires it).
                if tu.name == "BrowserApiWrite" and isinstance(result, dict) and result.get("ok"):
                    send_confirmed = True

                # Act-and-confirm: if the agent declared the change it expects, VERIFY it actually happened, success is observed, never assumed. A hit returns fast (act + confirm in one turn); a miss is a clear "may not have worked" (and a wedge surfaces as a clean not-confirmed, not a blind 20s timeout), so the agent never claims a success it didn't see or re-fires blindly.
                p_expect = (str(tu.input.get("expect") or "").strip()
                           if isinstance(tu.input, dict) else "")
                # A send-class click's text-probe is documented-unreliable (sent text renders late/split/scrolled off) and the composer-clear receipt supersedes it, so don't burn the 4s probe timeout on exactly the clicks that never confirm by text.
                p_is_send_click = (task_is_send and "error" not in result and tu.name in P_CONFIRM_TOOLS
                    and (browser_batch_replay.is_send_completed(
                        {"action": "click", "name": result.get("clickedName") or "",
                         "role": result.get("clickedRole") or ""}) or any(
                        browser_batch_replay.is_send_completed(
                            {"action": "click", "name": r.get("clickedName") or "",
                             "role": r.get("clickedRole") or ""})
                        for r in (result.get("results") or []))))
                if p_is_send_click and p_expect:
                    result["confirmed"] = True
                    result["text"] = f"{result.get('text') or ''}\nConfirmed by receipt: the send-class click registered."
                elif p_expect and "error" not in result and tu.name in P_CONFIRM_TOOLS:
                    # target_only: wait for the expected text to actually appear, don't call it 'not confirmed' just because the page settled first (a sent message lands in the thread a beat after settle, esp. under load)
                    p_conf = await browser_wait.smart_wait(p_wait_exec, browser_id, tab_id, 4000,
                                                          until=p_expect, target_only=True)
                    if isinstance(p_conf, dict):
                        result["confirmed"] = bool(p_conf.get("found"))
                        if p_conf.get("found"):
                            result["text"] = f"{result.get('text') or ''}\nConfirmed: '{p_expect}' is now present."
                        else:
                            result["text"] = (
                                f"{result.get('text') or ''}\nNOT confirmed: '{p_expect}' did not appear within "
                                f"{p_conf.get('waited_ms')}ms. This only means that exact text was not found on "
                                "the page; if this result already contains direct evidence (e.g. 'Verified: the "
                                "box now contains ...'), TRUST THAT and do not redo the action. Otherwise check "
                                "the page before assuming success, and never re-fire an irreversible action "
                                "(Send/Submit/Pay/Post) without first verifying the previous one did not go through."
                            )

                # Send completion: a SUCCESSFUL click on a send-class control (Send/ Submit/Post, opener-excluded so 'Message' never trips it) means the message went out, the composer clears instantly. We do NOT depend on the thread-text confirm here: the sent text often renders late, split across nodes, or scrolled off, so the text-probe is unreliable, which is exactly what left the model stalling to "double-check". A clean send click is proof enough; drive to the OUTCOME.
                if task_is_send and not send_confirmed and "error" not in result and tu.name in P_CONFIRM_TOOLS:
                    p_cn = result.get("clickedName") or ""
                    p_cr = result.get("clickedRole") or ""
                    p_send_click = browser_batch_replay.is_send_completed(
                        {"action": "click", "name": p_cn, "role": p_cr}) or any(
                        browser_batch_replay.is_send_completed(
                            {"action": "click", "name": r.get("clickedName") or "",
                             "role": r.get("clickedRole") or ""})
                        for r in (result.get("results") or []))
                    if p_send_click:
                        send_confirmed = True
                        if os.environ.get("OSW_RECEIPT_DONE", "1") != "0" and composer_committed_payload:
                            # Deterministic receipt, two-sided: the fill was SEEN committed to a textbox earlier, and the box must now be SEEN empty of it. Click-name alone is not proof (r228: send-labeled click after an uncommitted fill = false success); missing evidence falls through to the old model-verified path, so the failure mode costs turns, never a lie.
                            p_receipt_ok = False
                            try:
                                for p_rw in (0.4, 1.0):
                                    await asyncio.sleep(p_rw)
                                    p_rl2 = await asyncio.wait_for(
                                        p_wait_exec("BrowserListInteractives", {}, browser_id, tab_id),
                                        timeout=5.0)
                                    if isinstance(p_rl2, dict) and "error" not in p_rl2 and p_rl2.get("text"):
                                        if not payload_in_textbox(str(p_rl2["text"]), composer_committed_payload):
                                            p_receipt_ok = True
                                        break
                            except Exception:
                                p_receipt_ok = False
                            if p_receipt_ok:
                                done_called = True
                                done_success = True
                                p_payload = browser_batch_replay.send_payload_from_log(action_log, task)
                                p_aux_c, p_aux_m = await p_get_aux_client()
                                p_nice = (await compose_send_confirmation(p_aux_c, p_aux_m, task, p_payload)
                                          if p_payload else "")
                                done_message = p_nice or (
                                    f'Done, I sent "{p_payload}" for you.'
                                    if p_payload else
                                    "Done, I sent your message."
                                )
                                logger.info(f"[browser-receipt {session_id}] two-sided receipt passed (fill committed + composer cleared); run ends in code")
                            else:
                                logger.info(f"[browser-receipt {session_id}] receipt WITHHELD (composer state unverified); model verifies")
                        result["text"] = (f"{result.get('text') or ''}\n\n[task complete] The send "
                            "went through (the composer cleared). Don't re-check it. Finish now by "
                            "calling Done with your reply to the user.")

                action_log.append({
                    "tool": tu.name,
                    "input": tu.input,
                    "result_summary": result.get("text", result.get("error", ""))[:200],
                    "elapsed_ms": elapsed_ms,
                    # carried so a successful run distills into a replayable skill
                    "ok": "error" not in result,
                    "clicked_role": result.get("clickedRole"),
                    "clicked_name": result.get("clickedName"),
                    # per-sub click identities, aligned by index, so a batched click_index can distill into a replayable ClickByName
                    "sub_results": [
                        {"index": r.get("index"), "ok": "error" not in r,
                         "clicked_role": r.get("clickedRole"), "clicked_name": r.get("clickedName")}
                        for r in (result.get("results") or [])
                    ] if tu.name == "BrowserBatch" else None,
                })
                if result.get("url"):
                    last_seen_url = result["url"]
                card_gone_streak = card_gone_streak + 1 if card_is_unavailable(result) else 0

                # Error-recovery: the action MISSED (stale index, occlusion, off screen) but the page is alive. The model would otherwise spend a whole turn re-listing to see what happened; attach the CURRENT element list to the error so it re-acts next turn instead. Pure state enrichment, the action is NEVER retried (no double-send risk).
                if "error" in result and card_gone_streak == 0 and recoverable_tool_error(result.get("error", "")):
                    try:
                        p_rl = await asyncio.wait_for(
                            p_wait_exec("BrowserListInteractives",
                                       {"goal": current_next_goal} if current_next_goal else {},
                                       browser_id, tab_id), timeout=5.0)
                        if isinstance(p_rl, dict) and p_rl.get("text") and "error" not in p_rl:
                            attached_state_seen.clear()
                            attached_state_seen.update(
                                l for l in str(p_rl["text"]).splitlines() if l.startswith("["))
                            result["text"] = (f"{result.get('error')}\n\n[recovery] That action did not "
                                              f"take effect, but the page is live. Current elements (re-act "
                                              f"from HERE, do not just retry the old index):\n"
                                              f"{p_truncate_state(str(p_rl['text']))}")
                            recovery_attaches += 1
                            logger.info(f"[browser-recovery {session_id}] attached fresh state after "
                                        f"recoverable error at turn {turn}: {str(result.get('error'))[:60]}")
                    except Exception:
                        pass

                # a direct full list resets the delta baseline to what the model just saw
                if tu.name == "BrowserListInteractives" and "error" not in result:
                    attached_state_seen.clear()
                    attached_state_seen.update(
                        l for l in str(result.get("text") or "").splitlines() if l.startswith("[")
                    )
                p_auto_state = await post_action_state(
                    tu.name, tu.input, result, browser_id, tab_id, p_wait_exec, current_next_goal,
                    seen_lines=attached_state_seen,
                )
                if p_auto_state:
                    result["text"] = f"{result.get('text') or ''}{p_auto_state}"
                    # a mutation attached fresh state; it stays "available" through intervening reads (Wait/Extract don't invalidate it), so a later solo re-list is still caught as redundant.
                    fresh_state_pending = True
                p_fill_text = fill_text_of(tu.name, tool_input)
                if p_fill_text and payload_in_textbox(p_auto_state or "", p_fill_text):
                    composer_committed_payload = p_fill_text
                    # B: the model just TYPED the message into a composer on a send task, so finish the send in CODE (find Send, click, verify the composer cleared) instead of it burning ~3-4 turns on a Send button whose index goes stale after the fill. Uses what the MODEL typed, so un-quoted phrasings ("say hi" -> "hi") work; fails safe, an unverified click never claims delivery and send_confirmed blocks a resend.
                    if (task_is_send and not send_confirmed and tu.name in P_CONFIRM_TOOLS
                            and browser_send_script.autosend_enabled()):
                        p_cs = await browser_send_script.complete_send(
                            composer_committed_payload, p_auto_state or "", browser_id, tab_id,
                            execute_browser_tool, send_submit_index_in_state)
                        if p_cs.get("clicked"):
                            send_confirmed = True
                            action_log.extend(p_cs.get("log") or [])
                            if p_cs.get("sent"):
                                done_called = True
                                done_success = True
                                p_aux_c, p_aux_m = await p_get_aux_client()
                                done_message = (await compose_send_confirmation(
                                    p_aux_c, p_aux_m, task, composer_committed_payload)
                                    or f'Done, I sent "{composer_committed_payload}" for you.')
                                logger.info(f"[browser-autosend {session_id}] post-fill code-send delivered (receipt verified)")
                            else:
                                task = f"{task}\n\n[{p_cs.get('note')}]"
                                logger.info(f"[browser-autosend {session_id}] post-fill send click ran, receipt unverified; model verifies")

                # One gentle nudge per violating turn, folded onto the action that ran, so the model self-corrects next turn without us costing it one.
                if rp_reminder_pending and tu.name in ACTION_TOOLS_REQUIRING_REPORT:
                    rp_reminder_pending = False
                    result["text"] = (f"{result.get('text') or ''}\n\n[note] Action ran. Next turn, "
                                       "include ReportProgress (working_memory + next_goal) alongside "
                                       "your action so your plan stays visible.")

                # Auto-dismiss a blocking junk popup (cookie wall / upsell / coachmark) before it costs the model a turn. Mechanical, once per URL, only on the tight throwaway-dismiss vocabulary that never sits on a task-needed control, so it can't close anything required. After closing, re-list so the model sees the page beneath.
                if tu.name in P_AUTO_STATE_TOOLS and "error" not in result:
                    p_pop_url = (result.get("url") or last_seen_url or "").split("#")[0]
                    if p_pop_url and p_pop_url not in dismissed_popup_urls:
                        p_close = interstitial_dismiss_target("\n".join(attached_state_seen))
                        if p_close:
                            dismissed_popup_urls.add(p_pop_url)
                            p_dres = await p_cancellable(execute_browser_tool(
                                "BrowserClickByName", {"name": p_close}, browser_id, tab_id))
                            p_dok = isinstance(p_dres, dict) and "error" not in p_dres
                            logger.info(f"[browser-popup {session_id}] auto-dismissed '{p_close}' "
                                        f"ok={p_dok} on {p_pop_url[:80]}")
                            if p_dok:
                                p_fresh = await post_action_state(
                                    "BrowserClickByName", {}, p_dres or {}, browser_id, tab_id,
                                    p_wait_exec, current_next_goal, seen_lines=attached_state_seen)
                                result["text"] = (f"{result.get('text') or ''}\n\n[auto] Closed a blocking "
                                                  f"popup ('{p_close}'); the page beneath is now active.{p_fresh}")

                # Auto candidate scan: landing on a results-shaped page normally costs a read-then-decide turn pair; the cheap aux model reads it now so the pick happens on this same turn. Capped, per-URL, fail-silent (a miss just means the old two-turn dance).
                if (tu.name in P_AUTO_STATE_TOOLS and "error" not in result
                        and auto_scan_count < P_AUTO_SCAN_MAX_PER_RUN):
                    p_scan_url = (result.get("url") or last_seen_url or "").split("#")[0]
                    if p_scan_url and p_scan_url not in auto_scanned_urls and RESULTS_URL_RE.search(p_scan_url):
                        auto_scanned_urls.add(p_scan_url)
                        p_scan_json, p_sc_ms = await p_scan_results(task)
                        if p_scan_json:
                            auto_scan_count += 1
                            result["text"] = (
                                f"{result.get('text') or ''}\n\n[auto candidate scan] An assistant model read "
                                f"this results page against the task:\n{p_scan_json}\n"
                                "Treat it as a hint; verify on the page before acting."
                            )
                            action_log.append({
                                "tool": "BrowserExtract", "input": {"instruction": "(auto candidate scan)"},
                                "result_summary": p_scan_json[:200], "elapsed_ms": p_sc_ms, "ok": True,
                            })
                            browser_metrics.record_tool(
                                session_id, browser_id, turn, "BrowserExtract", p_sc_ms, ok=True,
                                error="", is_loop=False, stagnation_streak=0, result_len=len(p_scan_json),
                            )
                            logger.info(
                                f"[browser-cold {session_id}] auto candidate scan on {p_scan_url[:90]} "
                                f"in {p_sc_ms}ms ({len(p_scan_json)}ch)"
                            )
                        else:
                            logger.info(
                                f"[browser-cold {session_id}] auto candidate scan empty on "
                                f"{p_scan_url[:90]} after {p_sc_ms}ms"
                            )

                # Deferred replay re-check: the orchestrator often opens a fresh card on the wrong host, so the dispatch-time replay missed. Once a navigation lands us on a host that DOES have a matching skill, and nothing has dirtied the page yet, switch to replay (still verified per-step, still trust-gated). Fires at most once.
                if (not replay_rechecked and tu.name == "BrowserNavigate"
                        and replay_recheck_is_safe(action_log)):
                    cur_host = browser_skills.host_of(last_seen_url)
                    if cur_host and cur_host != replay_host:
                        replay_rechecked = True
                        p_deferred = await p_try_replay(cur_host, turn + 1, allow_prefix=True)
                        if p_deferred is not None:
                            return p_deferred
                        # a prefix replay just moved the page; tell the model on THIS result so it continues from the composer
                        if replay_prefix_note:
                            result["text"] = f"{result.get('text') or ''}{replay_prefix_note}"
                            replay_prefix_note = ""
                        elif not route_hint_keys:
                            p_h_skill, p_h_score = browser_skills.find_similar_skill(cur_host, skill_key_task)
                            if p_h_skill:
                                p_hint, route_hint_keys = browser_skills.render_route_hint(p_h_skill, skill_key_task, p_h_score)
                                if p_hint:
                                    result["text"] = f"{result.get('text') or ''}{p_hint}"
                                    logger.info(
                                        f"[browser-route {session_id}] hint attached at re-check turn {turn}: "
                                        f"host={cur_host} sim={p_h_score:.2f} steps={len(route_hint_keys)}"
                                    )

                if tu.name == "BrowserScreenshot" and result.get("image"):
                    final_screenshot = result["image"]

                # Loop detection: did we just repeat the same (tool, input, result) for the third time in a row? If so, attach a loud warning to this tool_result so the model is forced to acknowledge it on its next turn. Loop detection only covers the non-excluded tools, so skip the hash entirely for the excluded ones; otherwise a screenshot/read serializes its full ~1MB result here just for detect_loop to discard it (it short-circuits excluded tools to False anyway).
                if tu.name in LOOP_DETECTION_EXCLUDED_TOOLS:
                    is_loop = False
                else:
                    call_key = hash_tool_call(tu.name, tu.input, result)
                    is_loop = detect_loop(recent_tool_calls, call_key)
                    recent_tool_calls.append(call_key)
                    if len(recent_tool_calls) > LOOP_WINDOW_SIZE * 2:
                        recent_tool_calls = recent_tool_calls[-LOOP_WINDOW_SIZE * 2:]

                content_blocks = format_tool_result(result, tu.name)
                try:
                    url = result.get("url") or (tu.input or {}).get("url")
                    if url:
                        domain = p_extract_domain(str(url))
                        if domain and domain not in session.browser_domains:
                            session.browser_domains.append(domain)
                except Exception:
                    pass
                # The fast tier is ~0% used because the agent never thinks to ask. Once per host, when safe GET routes have been captured, nudge it: reading via the API beats re-scraping, especially in a batch loop.
                try:
                    p_rc = int(result.get("routes_available") or 0)
                    p_rhost = browser_skills.host_of(result.get("url") or last_seen_url)
                    if p_rc > 0 and p_rhost and p_rhost not in route_hinted_hosts:
                        route_hinted_hosts.add(p_rhost)
                        content_blocks = content_blocks + [{"type": "text", "text": (
                            f"\n\n💡 {p_rc} of this site's own API endpoint(s) were captured. To READ "
                            "data (and especially to repeat a read for many items), BrowserReplayRoute "
                            "(or a replay_route step in BrowserRepeatFlow) is much faster and more "
                            "reliable than navigating + scraping. See BrowserListRoutes.")}]
                except Exception:
                    pass
                if is_loop:
                    loop_trigger_count += 1
                    repeat_count = sum(1 for c in recent_tool_calls if c == call_key)
                    warning = LOOP_WARNING_TEXT.format(count=repeat_count)
                    logger.warning(
                        f"[browser-agent {session_id}] loop detected on {tu.name} "
                        f"(trigger #{loop_trigger_count}): {warning}"
                    )
                    content_blocks = content_blocks + [
                        {"type": "text", "text": f"\n\n⚠️ {warning}"}
                    ]

                # Stagnation: busy-but-stuck (no URL change + failures across a run of actions), distinct from the exact-repeat loop above.
                stagnation_streak, stagnation_prev_url, stagnation_prev_text, stag_nudge = advance_stagnation(
                    stagnation_streak, stagnation_prev_url, stagnation_prev_text, tu.name, result,
                )
                # Skip the nudge when the loud loop warning already fired this turn (avoid double-messaging), but the aux adjudication below is NOT gated on is_loop: repeated identical failures trip BOTH detectors, and that's exactly when the escape hatch is needed.
                if stag_nudge and not is_loop:
                    logger.warning(
                        f"[browser-agent {session_id}] stagnation streak "
                        f"{stagnation_streak} on {tu.name}"
                    )
                    content_blocks = content_blocks + [
                        {"type": "text", "text": f"\n\n⚠️ {stag_nudge}"}
                    ]

                # Under-batching nudge: two consecutive turns each spent a full model round-trip on ONE predictable action; say so on the result the model is about to read. Deterministic, code-fired.
                if (tu is tool_uses_sorted[-1] and single_action_streak >= 2
                        and "error" not in result and not is_loop and not stag_nudge):
                    single_action_streak = 0
                    batching_nudges += 1
                    logger.info(
                        f"[browser-batching {session_id}] nudge #{batching_nudges} fired at turn {turn}"
                    )
                    content_blocks = content_blocks + [{"type": "text", "text": (
                        "\n\n⚡ That was another full model round-trip spent on ONE action. If the "
                        "state above already names your next 2-3 targets, put them in ONE "
                        "BrowserBatch (or several tool calls in this same reply); they run in "
                        "order, settle between steps, and stop safely at the first failure, so a "
                        "conservative batch costs nothing. Keep irreversible steps "
                        "(Send/Submit/Pay/Post) solo."
                    )}]

                # Redundant-read nudge: the previous action already attached a fresh element list, and this turn spent a whole round-trip re-reading it. Reads are the biggest turn sink (measured ~16 of 25 turns).
                if (tu.name in ("BrowserListInteractives", "BrowserGetText")
                        and p_had_fresh_state and "error" not in result):
                    redundant_read_nudges += 1
                    fresh_state_pending = False  # nudge once per attached-state cluster
                    logger.info(
                        f"[browser-batching {session_id}] redundant-read nudge #{redundant_read_nudges} "
                        f"({tu.name}) at turn {turn}"
                    )
                    content_blocks = content_blocks + [{"type": "text", "text": (
                        "\n\n⚡ Your PREVIOUS action already ended with a fresh '[page state after "
                        "action]' element list, so this re-read cost a round-trip for nothing. Act "
                        "straight from the attached state; only re-read after it says it was truncated "
                        "or you genuinely changed the page in a way that list wouldn't reflect."
                    )}]
                # Deterministic nudging exhausted: ONE cheap aux adjudication to suggest a concrete next step before we keep failing.
                if stagnation_exhausted(stagnation_streak) and not aux_adjudicated:
                    aux_adjudicated = True
                    aux_client, aux_model = await p_get_aux_client()
                    if aux_client and aux_model:
                        recent = "\n".join(
                            f"- {a['tool']} -> {str(a.get('result_summary', ''))[:120]}"
                            for a in action_log[-3:]
                        )
                        page_text = str(result.get("text") or result.get("error") or "")
                        guidance = await p_cancellable(adjudicate_stuck(
                            aux_client, aux_model, current_next_goal, recent, page_text,
                        ))
                        if guidance:
                            content_blocks = content_blocks + [
                                {"type": "text", "text": f"\n\n💡 Suggested next step: {guidance}"}
                                ]

                p_ok = "error" not in result
                browser_metrics.record_tool(
                    session_id, browser_id, turn, tu.name, elapsed_ms,
                    ok=p_ok, error=result.get("error", ""),
                    is_loop=is_loop, stagnation_streak=stagnation_streak,
                    result_len=len(str(result.get("text") or result.get("error") or "")),
                )

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

            # Integrity backfill: every tool_use in the assistant turn MUST have a matching tool_result or the next API call 400s ("tool_use without tool_result"). A break mid-loop (cancel, or a turn that ran past the 30s upstream reset) can leave some unanswered, which silently corrupts the history AND the resume snapshot. Stub any missing one so the array is always well-formed, no matter which path fired.
            p_answered = {tr.get("tool_use_id") for tr in tool_results}
            for tu in tool_uses_sorted:
                if tu.id not in p_answered:
                    tool_results.append({
                        "type": "tool_result", "tool_use_id": tu.id,
                        "content": [{"type": "text", "text":
                            "(not run, the turn ended before this tool executed)"}],
                        "is_error": True,
                    })
            # Spin backstop asked for a wrap-up: ride the nudge out on this turn's tool_results (a text block alongside them) so the model's next turn is a clean Done instead of more looking.
            if wrapup_pending:
                tool_results.append({"type": "text", "text": P_WRAPUP_NUDGE})
            messages.append({"role": "user", "content": tool_results})

            if done_called:
                break

            if cancelled:
                break

            # Hard cap on loops: if the model keeps repeating itself even after we warn it, force-exit so we don't burn the entire turn budget on a stuck agent.
            if loop_trigger_count >= LOOP_HARD_CAP:
                logger.warning(
                    f"[browser-agent {session_id}] hit loop hard cap "
                    f"({LOOP_HARD_CAP}); force-exiting"
                )
                break

            # The card is unusable, gone (closed) OR hung (commands keep timing out / the page never responds). Either way the agent can't make progress, so stop retrying after a short streak and report honestly, instead of the 20-minute spin on a wedged tab.
            if card_gone_streak >= CARD_GONE_LIMIT:
                logger.warning(
                    f"[browser-agent {session_id}] browser card {browser_id} is unusable "
                    f"({card_gone_streak} consecutive gone/hung results); aborting fast"
                )
                if os.environ.get("OSW_DEADCARD_EVICT", "1") != "0":
                    DEAD_CARDS.add(browser_id)
                    logger.info(f"[browser-agent] {browser_id} marked dead; same-host reuse will skip it")
                    # Tear the wedged webview DOWN now, before recovery spawns a fresh card. Two heavy pages (the dead one + the recovery one) starve the renderer's event loop = the recovery-card wedge; unmounting the dead one frees its renderer process so the recovery card is the only heavy neighbor.
                    await p_evict_dead_card(dashboard_id, browser_id)
                break

        if cancel_event.is_set():
            session.status = "stopped"
            browser_metrics.record_task(session_id, browser_id, task, "stopped",
                                        metrics_started_at, turn + 1, action_log, session.tokens)
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

        # The model finishes through Done, so its `message` IS the user's reply (clean, conversational, no tag). The rare run that stops without calling Done falls back to its own terminal text, which is plain prose since no prompt asks for a machine tag anymore.
        if done_called:
            summary = done_message or "Done."
        else:
            summary = "\n".join(text_parts).strip() if text_parts else "Task completed."

        if not final_screenshot:
            try:
                ss_result = await execute_browser_tool(
                    "BrowserScreenshot", {}, browser_id, tab_id,
                )
                if ss_result.get("image"):
                    final_screenshot = ss_result["image"]
            except Exception:
                pass

        # Persist conversation history so the next BrowserAgent call on this browser can resume rather than re-orient. Trim to the most recent MAX_HISTORY_MESSAGES turns to keep token usage bounded; but never split a tool_use ↔ tool_result pair across the cut, or the next API request will 400.
        browser_history.BROWSER_HISTORY[browser_id] = trim_history_by_turns(
            messages, MAX_HISTORY_MESSAGES,
        )

        # Honesty gate: the model declaring done is not proof the goal happened. If the run did no real work (zero actions, all actions errored, or only looked around), report the truth instead of a ghost "completed". A gone card gets its own precise reason instead of the generic verdict.
        if card_gone_streak >= CARD_GONE_LIMIT:
            honest, dishonest_reason = False, "the browser became unresponsive (the tab hung or was closed); it needs a fresh browser to continue"
        else:
            honest, dishonest_reason = completion_is_honest(action_log)
        final_status = "completed" if honest else "error"
        if not honest:
            summary = f"I was not able to complete this task ({dishonest_reason})."
            logger.warning(
                f"[browser-agent {session_id}] completion gate caught a ghost: "
                f"model declared done but {dishonest_reason}; reporting as error"
            )

        session.status = final_status
        logger.info(
            f"[browser-batching {session_id}] run summary: turns={turn + 1} "
            f"multi_action_turns={multi_action_turns} batch_calls={batch_calls} "
            f"nudges={batching_nudges} redundant_reads={redundant_read_nudges} "
            f"guard_blocks={batch_guard_blocks}"
        )
        # Route-hint adoption: of the hinted steps, how many did the run actually take? Pure telemetry; this is how we learn whether hints steer or get ignored (the batching-nudge lesson: measure, don't assume).
        if route_hint_keys:
            p_adopted = sum(1 for k in route_hint_keys if browser_skills.hint_step_adopted(k, action_log))
            logger.info(
                f"[browser-route {session_id}] adoption: {p_adopted}/{len(route_hint_keys)} "
                f"hinted steps matched by executed actions"
            )
        p_tools_ms_total = sum(int(a.get("elapsed_ms", 0) or 0) for a in action_log)
        p_wall_ms = int((time.time() - metrics_started_at) * 1000)
        p_err_tools = sum(1 for a in action_log if not a.get("ok", True))
        logger.info(
            f"[browser-time {session_id}] wall={p_wall_ms}ms llm={llm_ms_total}ms "
            f"tools={p_tools_ms_total}ms other={max(0, p_wall_ms - llm_ms_total - p_tools_ms_total)}ms "
            f"auto_scans={auto_scan_count} hint_steps={len(route_hint_keys)} "
            f"tool_errors={p_err_tools} recovery_attaches={recovery_attaches} rp_violations={rp_violations}"
        )
        p_nt = turn + 1
        # merge-verify telemetry: read-only tool calls AFTER the last state-changing action are the redundant trailing "let me re-verify" turns the prompt now folds into the OUTCOME line; this should trend to 0 on the confirmed path.
        p_act_tools = {"BrowserType", "BrowserClickIndex", "BrowserClick", "BrowserClickByName",
                      "BrowserPressKey", "BrowserScroll", "BrowserBatch", "BrowserNavigate"}
        p_read_tools = {"BrowserScreenshot", "BrowserGetText", "BrowserGetElements",
                       "BrowserListInteractives", "BrowserExtract"}
        p_last_act = max((i for i, a in enumerate(action_log)
                         if a.get("tool") in p_act_tools and a.get("ok")), default=-1)
        p_trailing_reads = sum(1 for a in action_log[p_last_act + 1:]
                              if a.get("tool") in p_read_tools) if p_last_act >= 0 else 0
        logger.info(
            f"[browser-output {session_id}] out_tokens={out_tokens_total} "
            f"mean_out_per_turn={out_tokens_total // max(1, p_nt)} narration_turns={narration_turns}/{p_nt} "
            f"trailing_reads={p_trailing_reads}"
        )
        browser_metrics.record_task(session_id, browser_id, task, final_status,
                                    metrics_started_at, turn + 1, action_log, session.tokens,
                                    path="llm_fallback" if replay_attempted else "llm",
                                    task_sig=browser_skills.compute_sig(skill_key_task),
                                    playbook_seeded=pb_seeded)
        # Learn this task ONLY from a genuinely successful run whose deliverable a deterministic replay can actually reproduce. We skip recording when the run was dishonest (ghost) OR when its answer was gathered/judged content (a list/report): replay can redo the clicks but not regenerate the judgment, so recording it would create a thin shortcut that later ghosts.
        informational = deliverable_is_informational(summary, skill_key_task)
        logger.info(f"[browser-skills] record gate: honest={honest} informational={informational}")
        if honest and not informational:
            try:
                rec_host = browser_skills.host_of(last_seen_url)
                p_distilled = browser_skills.distill_steps(action_log)
                logger.info(
                    f"[browser-skills] record attempt: host={rec_host!r} "
                    f"last_url={last_seen_url!r} action_tools={[a.get('tool') for a in action_log]} "
                    f"distilled={[s['tool'] for s in p_distilled]}"
                )
                if browser_skills.record_skill(rec_host, skill_key_task, action_log):
                    logger.info(f"[browser-skills] learned skill for {rec_host} (future runs replay fast)")
                else:
                    logger.info(f"[browser-skills] NOT recorded (host empty or no robust steps)")
            except Exception as e:
                logger.warning(f"[browser-skills] record raised: {e}")
        elif honest and informational:
            logger.info("[browser-skills] NOT recorded (deliverable was gathered/judged content; "
                        "replay can't reproduce it, so no thin-shortcut ghost)")

        # Tier-2 memory: on a substantive verified success, distill this run into the DURABLE strategy playbook (one cheap aux call, mem0-style distill+ reconcile). Fires for BOTH mechanical and judgment tasks, it's how the judgment ones (which can't be skills) still get faster/wiser next time.
        if browser_playbook.should_learn(honest, turn + 1):
            async def p_distill_learning() -> None:
                try:
                    # App mode keys by the stable app id (the run had no URL host); web keys by the final host, which navigation may have changed.
                    rec_pb_host = browser_id if app_mode else browser_skills.host_of(last_seen_url)
                    if not rec_pb_host:
                        return
                    aux_client, aux_model = await p_get_aux_client()
                    changed = await browser_playbook.distill_and_store(
                        rec_pb_host, skill_key_task, latest_working_mem, summary,
                        aux_client, aux_model,
                    )
                    # Perceived value, zero clicks: a calm closing line so the user sees the agent got a little smarter for next time. Only when it genuinely learned something, so it stays honest + rare.
                    if changed:
                        session.memory_learned = True  # drives the subtle "Learned" card chip
                        p_where = "this app" if app_mode else rec_pb_host
                        p_learn_msg = Message(role="assistant",
                                             content=f"Noted what worked on {p_where} so I'm faster here next time.")
                        session.messages.append(p_learn_msg)
                        await ws_manager.send_to_session(session_id, "agent:message", {
                            "session_id": session_id, "message": p_learn_msg.model_dump(mode="json"),
                        })
                except Exception as e:
                    logger.debug(f"[browser-playbook] distill skipped: {e}")
            # Learning is advisory to FUTURE runs, so the user's reply must not wait on this aux call; it used to sit between "done" and the reply.
            p_lt = asyncio.create_task(p_distill_learning())
            learn_tasks.add(p_lt)
            p_lt.add_done_callback(learn_tasks.discard)
        # The model asked to leave the browser open because the deliverable lives on the page (a video playing, a page to read). Pin the card so the auto-close on parent finish skips it. Only on honest success: never pin a broken or ghost run open. The keep broadcast lands before the parent reaches terminal state (it awaits this run), so the frontend has the flag set before any close path runs.
        if honest and done_keep_open and dashboard_id:
            try:
                from backend.apps.dashboards.dashboards import load, save
                dashboard = load(dashboard_id)
                card = dashboard.layout.browser_cards.get(browser_id)
                if card is not None:
                    card.keep_open = True
                    dashboard.updated_at = datetime.now()
                    save(dashboard)
                    await ws_manager.broadcast_global("dashboard:browser_card_keep", {
                        "dashboard_id": dashboard_id,
                        "browser_id": browser_id,
                    })
            except Exception as e:
                logger.warning(f"[browser-agent {session_id}] keep_open persist failed: {e}")

        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": final_status,
            "session": session.model_dump(mode="json"),
        })

        return {
            "session_id": session_id,
            "browser_id": browser_id,
            "summary": summary,
            # structured success signal the parent reads (replaces grepping the summary for a tag): true ONLY when the model explicitly finished via Done with success AND the honesty gate agreed. A run that just stopped (max turns, gave up, never called Done) is NOT a clean success, so the fast path recovers instead of shipping a silent half-finish.
            "done": honest and done_called and done_success,
            # surface the honest failure to the parent so it doesn't treat a did-nothing run as a success it can build on
            **({} if honest else {"error": summary}),
            "action_log": action_log,
            "final_screenshot": final_screenshot,
        }

    except Exception as e:
        logger.exception(f"Browser agent {session_id} error: {e}")
        session.status = "error"
        browser_metrics.record_task(session_id, browser_id, task, "error",
                                    metrics_started_at, locals().get("turn", -1) + 1,
                                    action_log, session.tokens)
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


# Cards a sub-agent is actively driving in this process. Reuse must never hand two agents one webview (their commands would interleave into chaos).
ACTIVE_AGENT_CARDS: set[str] = set()
# Cards a run declared unusable (gone/hung streak); reuse must not resurrect them or every retry inherits the wedge.
DEAD_CARDS: set[str] = set()
# find+claim+create must be one critical section or two parallel dispatches race to claim the same idle card (or both miss and double-create).
p_card_pick_lock = asyncio.Lock()


def find_reusable_card(dashboard_id: str, url: str, parent_session_id: str | None) -> str:
    """An existing same-host spawned card to drive instead of stacking another
    webview: concurrent same-site webviews wedge each other (shared-partition
    lock contention), so a retry must REUSE, not multiply. The parent's own
    card first, else one orphaned by a finished parent. User-created cards
    (no spawned_by) are never grabbed implicitly."""
    want = browser_skills.host_of(url)
    if not (dashboard_id and want):
        return ""
    try:
        from backend.apps.dashboards.dashboards import load
        cards = load(dashboard_id).layout.browser_cards
    except Exception:
        return ""
    from backend.apps.agents.agent_manager import agent_manager
    own, orphan = "", ""
    for bid, card in cards.items():
        spawned = getattr(card, "spawned_by", None)
        if not spawned or bid in ACTIVE_AGENT_CARDS or bid in DEAD_CARDS:
            continue
        if browser_skills.host_of(getattr(card, "url", "") or "") != want:
            continue
        if spawned == parent_session_id:
            own = own or bid
        else:
            parent = agent_manager.get_session(spawned)
            if parent is None or getattr(parent, "status", "") != "running":
                orphan = orphan or bid
    return own or orphan


# The renderer needs a beat to unmount the <webview> and let Electron free its
# renderer process. Recovery spawns its fresh card the instant this returns, so we
# hold here until the teardown has almost certainly landed, else the new card mounts
# next to a still-freeing dead one and eats the same 15s starvation cap (observed
# live: recovery card f47d8bdd still capped once even with evict firing). This wait
# is on the FAILURE path only, so its cost is invisible next to the cap it prevents.
P_EVICT_SETTLE_S = 1.5


async def p_evict_dead_card(dashboard_id: str | None, browser_id: str) -> None:
    """Free a wedged card's webview so the recovery card isn't its heavy neighbor:
    tell the renderer to unmount it (frees the renderer process), drop it from the
    persisted layout, and WAIT for the teardown to land before the caller spawns the
    recovery card. Fail-open, never raises into the abort path.
    ONLY agent-spawned cards are ever evicted: a user's own card (they selected it
    for the agent) must never be deleted out from under them, wedged or not; for
    those the DEAD_CARDS reuse-skip is the whole remedy."""
    ACTIVE_AGENT_CARDS.discard(browser_id)
    try:
        from backend.apps.dashboards.dashboards import load as p_dash_load
        p_card = p_dash_load(dashboard_id).layout.browser_cards.get(browser_id) if dashboard_id else None
        if p_card is None or not getattr(p_card, "spawned_by", None):
            logger.info(f"[browser-agent] {browser_id} is not an agent-spawned card; skipping evict (reuse-skip only)")
            return
    except Exception:
        return
    try:
        await ws_manager.broadcast_global("dashboard:browser_card_evict", {
            "dashboard_id": dashboard_id or "", "browser_id": browser_id})
    except Exception:
        pass
    if dashboard_id:
        try:
            from backend.apps.dashboards.dashboards import load, save
            dash = load(dashboard_id)
            if browser_id in dash.layout.browser_cards:
                del dash.layout.browser_cards[browser_id]
                dash.updated_at = datetime.now()
                save(dash)
        except Exception:
            pass
    # Let the renderer finish unmounting BEFORE recovery mounts its replacement.
    await asyncio.sleep(P_EVICT_SETTLE_S)


async def p_create_browser_card(dashboard_id: str, url: str, parent_session_id: str | None = None) -> str:
    """Create a new browser card on the dashboard and return its browser_id."""
    from backend.apps.dashboards.dashboards import load, save
    from backend.apps.dashboards.models import BrowserCardPosition, BrowserTab

    dashboard = load(dashboard_id)
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
        dashboard_id=dashboard_id,
    )
    dashboard.layout.browser_cards[browser_id] = card
    dashboard.updated_at = datetime.now()
    save(dashboard)

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
    pass  # Browser agent launch captured via session dump

    # No dashboard renderer means every browser command is dead on arrival; failing here saves the 2-5 LLM turns a sub burns narrating timeouts at a corpse before card-gone detection trips. But a CPU-starved renderer can briefly drop its WS then auto-reconnect, so wait (capped) for it to come back before refusing, turning a load blip into a pause, not a failed run.
    if not ws_manager.global_connections and not await await_reconnect(lambda: bool(ws_manager.global_connections)):
        logger.warning("[browser-agent] dispatch refused: no dashboard after reconnect wait")
        return [{
            "summary": (
                "Error: no dashboard window is connected, so browser tools cannot run. "
                "Tell the user to open the OpenSwarm window and try again; do not retry until they do."
            ),
            "action_log": [], "final_screenshot": None,
        } for _ in tasks]

    pre_selected = set(pre_selected_browser_ids or [])

    # The user explicitly picked a browser via select-mode, so that card must be driven instead of spawning a fresh one. The model often omits browser_id when calling the tool, which used to fall through to host-based auto-create (the "it always opens its own browser" bug); here we hand each unclaimed selected card to the next task that named none, BEFORE the parallel dispatch so it can't race the card-pick lock.
    p_unclaimed = [b for b in (pre_selected_browser_ids or []) if b]
    for p_t in tasks:
        if not p_t.get("browser_id") and p_unclaimed:
            p_t["browser_id"] = p_unclaimed.pop(0)

    async def p_run_one(task_def: dict) -> dict:
        browser_id = task_def.get("browser_id", "")
        task_text = task_def.get("task", "")
        url = task_def.get("url", "")
        # App mode: browser_id is a pre-registered app webview ("app:<output_id>"); never create/reuse a browser card, never navigate (the app is loaded).
        app_mode = bool(task_def.get("app_mode"))
        # advisory deep entry (from the fast-path brief): a NEW card opens on it directly (no google detour); a REUSED card is never moved by it, so a warm card's deeper page state always wins
        entry_url = task_def.get("entry_url", "")

        reused = False
        if not browser_id and dashboard_id:
            # the url param is often empty with the target buried in the task text; a url there still names the host we must not duplicate
            host_src = url or entry_url or next(iter(re.findall(r"https?://[^\s)\"'<>]+", task_text)), "")
            async with p_card_pick_lock:
                browser_id = find_reusable_card(dashboard_id, host_src, parent_session_id)
                if browser_id:
                    reused = True
                else:
                    browser_id = await p_create_browser_card(dashboard_id, url or entry_url, parent_session_id)
                    if entry_url and not url:
                        logger.info(f"[browser-cold] new card {browser_id} opens at brief entry {entry_url}")
                ACTIVE_AGENT_CARDS.add(browser_id)
            if reused:
                logger.info(f"[browser-agent] reusing same-host card {browser_id} instead of stacking another webview")
                if url:
                    # a retry starts from the task's entry URL, never the failed attempt's leftover page state
                    try:
                        await execute_browser_tool("BrowserNavigate", {"url": url}, browser_id)
                    except Exception:
                        pass
            elif os.environ.get("OSW_PRELUDE_TRIM", "1") != "0":
                # Poll until the mounting card serves real page text instead of a blind 2s; capped, so the worst case is the old wait plus one probe.
                p_mount_t0 = time.monotonic()
                while time.monotonic() - p_mount_t0 < 2.5:
                    try:
                        p_probe = await execute_browser_tool("BrowserGetText", {}, browser_id)
                        if (isinstance(p_probe, dict) and not p_probe.get("error")
                                and len(str(p_probe.get("text") or "")) > 200):
                            break
                    except Exception:
                        pass
                    await asyncio.sleep(0.25)
                logger.info(f"[browser-cold] mount poll {int((time.monotonic() - p_mount_t0) * 1000)}ms for {browser_id}")
            else:
                await asyncio.sleep(2.0)
        elif browser_id and not app_mode:
            ACTIVE_AGENT_CARDS.add(browser_id)

        is_pre_selected = browser_id in pre_selected
        p_nav_url = url or ("" if reused else entry_url)
        # The fresh card already opened AT entry_url, so the pre-loop nav is a full second page load of the same page; trim mode drops it (perceive reads the mounting page, and the loop can still navigate itself if that read comes up empty).
        if (os.environ.get("OSW_PRELUDE_TRIM", "1") != "0" and not reused and not url
                and entry_url and p_nav_url == entry_url):
            p_nav_url = ""
        try:
            return await run_browser_agent(
                task=task_text,
                browser_id=browser_id,
                model=model,
                dashboard_id=dashboard_id,
                pre_selected=is_pre_selected,
                # an explicit url means "go here" even on the user's picked card; with none, a picked card stays on the page they parked it
                initial_url=None if app_mode else (p_nav_url if p_nav_url and (url or browser_id not in pre_selected) else None),
                parent_session_id=parent_session_id,
                app_mode=app_mode,
                user_prompt=str(task_def.get("user_prompt") or ""),
            )
        finally:
            if not app_mode:
                ACTIVE_AGENT_CARDS.discard(browser_id)

    results = await asyncio.gather(*[p_run_one(t) for t in tasks], return_exceptions=True)

    final = []
    for r in results:
        if isinstance(r, Exception):
            final.append({"summary": f"Error: {str(r)}", "action_log": [], "final_screenshot": None})
        else:
            final.append(r)
    return final
