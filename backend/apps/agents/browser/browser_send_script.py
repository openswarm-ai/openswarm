"""
Staged-send script: when the pre-stage leaves a READY composer (a compose
textbox and a real Send button both visible) and the task names its payload in
quotes, code performs the fill/verify/send/verify tail the model otherwise
spends 4-5 turns (~15s) on.

Safety is the same bar as the loop's, enforced in code: the payload must be
SEEN committed to the textbox before the one irreversible click, the Send
button is re-resolved from fresh state after the fill (indices shift), and the
composer must be SEEN cleared after. Any ambiguity BEFORE the click aborts to
the untouched model path; ambiguity AFTER the click hands the model a truthful
"clicked, unverified, do NOT re-send" note, never a silent retry.
"""

import asyncio
import json
import logging
import os
import re
import time
from typing import Awaitable, Callable, Dict

from backend.apps.agents.browser import browser_fast_path, browser_submit_click, browser_verified_action

logger = logging.getLogger(__name__)


# Double quotes are unambiguous. Single quotes only delimit when the opener is at a word boundary (start/space/colon), so an in-word apostrophe like "chen's" is never mistaken for a payload quote, that mispairing was silently corrupting the canonical "text him '...'" errand.
P_QUOTED_DQ_RE = re.compile(r'"([^"]{4,300})"')
P_QUOTED_SQ_RE = re.compile(r"(?:^|[\s:>])'([^']{4,300})'")
P_COMPOSER_ROW_RE = re.compile(r"\[(\d+)\]\*?<\s*textbox\s+\"([^\"]*)\"", re.I)
# A compose-shaped textbox name, generalized across messaging sites: LinkedIn "Write a
# message", X/Slack "Message", Discord "Message @user", Gmail "Message Body", "Post your
# reply", "What's happening", "Add a comment". Not per-site: one structural shape.
P_COMPOSER_NAME_RE = re.compile(
    r"write|messag|compose|reply|comment|post your|post text|what.?s happening|"
    r"tweet|caption|say something|start a|new message|body|your (message|note)|"
    r"add a comment|write something",
    re.I,
)

# Login/auth walls: a logged-out card lands here, and the structural reveal-finder would
# otherwise fill a login field and arm the page's own submit as a "send" (measured live on
# instagram/threads). A real composer never lives on one of these, so decline outright.
P_LOGIN_WALL_URL_RE = re.compile(
    r"accounts\.google\.com|/i/flow/login|/accounts/login|/uas/login|/users/sign_in|"
    r"/sessions/new|/checkpoint|force_authentication|"
    r"/(?:log[_-]?in|sign[_-]?in|signin|logon)(?:[/?#]|$)",
    re.I,
)
P_LOGIN_WALL_STATE_RE = re.compile(
    r'<\s*textbox\s+"[^"]*(?:password|passwd)|(?:log|sign)\s?in to |'
    r"continue with (?:google|apple|facebook)",
    re.I,
)


def looks_like_login_wall(current_url: str, state_text: str) -> bool:
    """A login/auth page (by URL) or an auth form in the perception (a password field, a
    'Log in to X' heading, an OAuth 'Continue with ...'). The scripted send declines here:
    a real composer never shares a page with these, and filling here types a login field."""
    if current_url and P_LOGIN_WALL_URL_RE.search(current_url):
        return True
    return bool(state_text and P_LOGIN_WALL_STATE_RE.search(state_text))


ToolRunner = Callable[[str, dict, str, str], Awaitable[dict]]


def script_enabled() -> bool:
    return os.environ.get("OSW_SEND_SCRIPT", "0") != "0"


def autosend_enabled() -> bool:
    """The mid-loop post-fill takeover: after the MODEL types the message into a composer, the code
    finishes the send (find Send, click, verify receipt) instead of the model burning ~3-4 turns on
    a Send button whose index goes stale after the fill. Rides with the send-script family (same
    tail + safety), with its own kill switch."""
    return script_enabled() and os.environ.get("OSW_AUTOSEND", "1") != "0"


async def complete_send(
    payload: str, state_committed: str, browser_id: str, tab_id: str,
    execute_tool: ToolRunner, send_index_in_state: Callable[[str, int], object],
    composer_index: int = -1,
) -> Dict[str, object]:
    """Send tail for a composer that ALREADY holds `payload` (visible in state_committed): find the
    Send control (ranked index first, else click-by-name over the full DOM), click it once, and
    verify the two-sided receipt (the composer cleared the payload). Returns {clicked, sent, log,
    note}: `clicked` = the send click landed, `sent` = the clear was verified. Never types, so it
    can't fabricate content; a wrong Send match just fails the receipt, never a false claim. Shared
    by the dispatch send-script and the mid-loop post-fill takeover."""
    log: list = []

    async def fresh_list() -> str:
        try:
            r = await asyncio.wait_for(
                execute_tool("BrowserListInteractives", {}, browser_id, tab_id), timeout=6.0)
            return str(r.get("text") or "") if isinstance(r, dict) and "error" not in r else ""
        except Exception:
            return ""

    send_btn = send_index_in_state(state_committed, composer_index)
    via = "index"
    if send_btn:
        r_send = await execute_tool("BrowserClickIndex", {"index": send_btn[0]}, browser_id, tab_id)
        send_name = send_btn[1]
    else:
        # No submit listed below the composer (the capped listing can starve a modal of its own
        # button): click the submit inside the composer's OWN container, then last-resort by-name.
        r_send = await execute_tool(
            "BrowserEvaluate",
            {"expression": browser_submit_click.container_submit_expression(payload)}, browser_id, tab_id)
        p_v = browser_submit_click.parse_eval_value(r_send)
        if isinstance(p_v, dict) and p_v.get("ok"):
            send_name = str(p_v.get("name") or "submit")
            via = "container"
        else:
            p_why = p_v.get("why") if isinstance(p_v, dict) else "unreadable eval"
            logger.info(f"[browser-sendscript] container submit miss ({p_why}); by-name fallback")
            r_send = await execute_tool("BrowserClickByName", {"name": "Send", "role": "button"}, browser_id, tab_id)
            send_name = "Send (by-name)"
            via = "by-name"
    clicked = isinstance(r_send, dict) and "error" not in r_send
    log.append({"tool": "send click", "input": {"via": via},
                "ok": clicked, "result_summary": f"send click {send_name!r}"[:200],
                "elapsed_ms": 0, "clicked_role": "button", "clicked_name": send_name})
    if not clicked:
        return {"clicked": False, "sent": False, "log": log, "note": "send click errored; fill committed, NOT sent"}
    sent = False
    for wait_s in (0.4, 1.0, 1.6):
        await asyncio.sleep(wait_s)
        state3 = await fresh_list()
        if state3 and browser_verified_action.expectation_met(f"cleared:{payload}", state_committed, state3):
            sent = True
            break
    note = ("" if sent else
            "A Send-class click already RAN for this payload but the composer state is unverified: "
            "verify on the page whether it delivered; do NOT send again unless verifiably absent.")
    return {"clicked": True, "sent": sent, "log": log, "note": note}


def quoted_payload(task: str) -> str:
    """The exact text the user quoted, only when it's unambiguous: exactly one
    distinct quoted span in the task. Anything else is the model's judgment call.
    Double quotes win outright; single quotes must be word-boundary-delimited so
    an apostrophe inside a name can't hijack the match."""
    dq = {m.group(1).strip() for m in P_QUOTED_DQ_RE.finditer(task or "") if m.group(1).strip()}
    if dq:
        return dq.pop() if len(dq) == 1 else ""
    sq = {m.group(1).strip() for m in P_QUOTED_SQ_RE.finditer(task or "") if m.group(1).strip()}
    return sq.pop() if len(sq) == 1 else ""


P_OPENER_ROW_RE = re.compile(
    r"\[(\d+)\]\*?<\s*(?:link|button)\s+\"(Message|Reply|Compose|New message|"
    r"Direct message|DM|Send message|Write|New chat|Comment|Post)\"", re.I)

# A verification probe quotes the very payload it's checking for, which is exactly the trap this gate exists for: quoted payload + composer = fire. Caught live (r243): the read-only send-probe delivered a REAL message. Read-only directives decline in code, fail-safe (a false match just means the model path).
P_READONLY_RE = re.compile(
    r"read.?only|do\s+not\s+(?:send|type|click|post|submit)|don'?t\s+(?:send|post|submit)|"
    r"verify\s+whether|check\s+whether|verification",
    re.I,
)


def opener_index_in_state(state_text: str):
    """(index, name) of the single exact-named composer OPENER, or None. Exact
    names only, so an upsell like 'Send InMail' can never match."""
    hits = [(int(m.group(1)), m.group(2)) for m in P_OPENER_ROW_RE.finditer(state_text or "")]
    return hits[0] if len(hits) == 1 else None


def composer_index_in_state(state_text: str):
    """(index, name) of the single compose-shaped textbox, or None. Two
    candidates = ambiguous = model's problem."""
    hits = [(int(m.group(1)), m.group(2)) for m in P_COMPOSER_ROW_RE.finditer(state_text or "")
            if P_COMPOSER_NAME_RE.search(m.group(2) or "")]
    return hits[0] if len(hits) == 1 else None


def surface_supports_script(current_url: str, state_text: str = "") -> bool:
    """STRUCTURAL, not per-site: fire wherever the live perception actually carries a
    person-composer (a compose-shaped textbox) OR a single messaging opener to reach
    one, on ANY host. This is what generalizes the LinkedIn ~14s send to X/Slack/
    Discord/Instagram/Gmail/etc without per-site URL gates. A page with neither
    declines (net-negative to fire where there's no composer). All the downstream
    safety gates (quoted payload, fill-seen-committed before the one send, two-sided
    receipt) are already site-agnostic, so widening the surface can't loosen safety."""
    if not state_text:
        return False
    return bool(composer_index_in_state(state_text) or opener_index_in_state(state_text))


def dryrun_report(state_text: str, armed: bool, filled: bool, url: str = "") -> str:
    """One grep-stable line for the coverage harness: what the staged perception held
    and how far the script got. Only ever emitted in dry-run measurement mode."""
    boxes = len(P_COMPOSER_ROW_RE.findall(state_text or ""))
    return (f"[dryrun-report] armed={int(bool(armed))} "
            f"composer={int(bool(composer_index_in_state(state_text or '')))} "
            f"opener={int(bool(opener_index_in_state(state_text or '')))} "
            f"textboxes={boxes} filled={int(bool(filled))} url={(url or '')[:120]}")


async def run_send_script(
    task: str,
    browser_id: str,
    tab_id: str,
    state_text: str,
    execute_tool: ToolRunner,
    send_index_in_state,
    payload_in_textbox,
    payload_source: str = "",
    current_url: str = "",
) -> dict | None:
    """None = stage not script-ready or aborted pre-click (model path, stage
    untouched except a possibly committed fill, which the model sees). A dict
    means the irreversible click RAN: {'sent': bool_receipt_verified,
    'payload': str, 'log': [...], 'note': str}. payload_source is the RAW user
    prompt; the composed task carries the routing brief whose own quoted strings
    made every real payload look ambiguous (r242/r243)."""
    t0 = time.monotonic()
    p_struct = os.environ.get("OSW_COMPOSER_STRUCT") == "1"

    async def fresh_list() -> str:
        try:
            r = await asyncio.wait_for(
                execute_tool("BrowserListInteractives", {}, browser_id, tab_id), timeout=6.0)
            return str(r.get("text") or "") if isinstance(r, dict) and "error" not in r else ""
        except Exception:
            return ""

    # The name-based surface gate can't see an unnamed/non-standard composer; under the
    # structural flag, don't early-decline on it, the in-page finder gets a chance below.
    if not surface_supports_script(current_url, state_text) and not p_struct:
        # The composer lazy-renders a beat after prestage snapshotted (X home does this ~half the
        # time), so poll a fresh perception before declining, else a late box is a false "no
        # composer" and the whole write flakes to the slow model path.
        for wait_s in (0.6, 1.0, 1.4):
            await asyncio.sleep(wait_s)
            fresh = await fresh_list()
            if surface_supports_script(current_url, fresh):
                state_text = fresh
                break
        else:
            logger.info(f"[browser-sendscript] decline: no composer or opener after poll ({current_url[:50]!r})")
            return None
    # Key read-only on words a HUMAN wrote: the task minus the aux routing brief (the brief wrote
    # "do not submit it" for a plain "start a post", falsely read-only-flagging a real send) PLUS
    # the raw prompt when threaded through. The task text itself must keep declining regardless: a
    # read-only VERIFY probe arrives as the task, and one once delivered a real message (r243).
    task_sans_brief = task.split(browser_fast_path.BRIEF_MARKER, 1)[0]
    if P_READONLY_RE.search(task_sans_brief) or (payload_source and P_READONLY_RE.search(payload_source)):
        logger.info("[browser-sendscript] decline: read-only directive in user request")
        return None
    if looks_like_login_wall(current_url, state_text):
        logger.info(f"[browser-sendscript] decline: login/auth wall ({(current_url or '')[:60]!r})")
        return None
    payload = quoted_payload(payload_source or task)
    if not payload:
        logger.info("[browser-sendscript] decline: no unambiguous quoted payload")
        return None
    log: list[dict] = []

    composer = composer_index_in_state(state_text)
    if not composer:
        # The staged snapshot is prestage's, frozen the instant it clicked Message; the overlay composer lazy-renders a beat later (r263/r269 declined on exactly this, prestage's LAST step was the Message click). Poll a short window so the overlay has time to appear before we fall back to the opener.
        for wait_s in (0.6, 1.2, 1.4):
            await asyncio.sleep(wait_s)
            fresh = await fresh_list()
            composer = composer_index_in_state(fresh)
            if composer:
                state_text = fresh
                break
    p_struct_selector: str = ""
    if not composer:
        # Reversible-opener hop: prestage often stops on the profile with the "Message" opener visible (its settle raced the overlay). Opening a composer is the allowed opener class; the irreversible bar is unchanged.
        opener = opener_index_in_state(state_text)
        if opener:
            logger.info(f"[browser-sendscript] firing via opener {opener[1]!r} [{opener[0]}]")
            r_open = await execute_tool("BrowserClickIndex", {"index": opener[0]}, browser_id, tab_id)
            if not (isinstance(r_open, dict) and "error" not in r_open):
                return None
            log.append({"tool": "BrowserClickIndex", "input": {"index": opener[0]}, "ok": True,
                        "result_summary": f"script opened composer via {opener[1]!r}"[:200], "elapsed_ms": 0})
            for wait_s in (0.6, 1.2):
                await asyncio.sleep(wait_s)
                state_text = await fresh_list()
                composer = composer_index_in_state(state_text)
                if composer:
                    break
        # Structural fallback: the AX-name detector missed it (an unnamed contenteditable, a
        # non-standard rich editor, or two textboxes it couldn't disambiguate). Ask the page to
        # rank its editable regions and fill+read-back the winner IN-PAGE (the only reliable
        # commit-check for a React contenteditable, whose text never reaches the AX value).
        # Flag-gated so the proven name path stays the default.
        if not composer and p_struct:
            # OSW_COMPOSER_REVEAL: let the finder take one reversible reveal action (open the
            # compose surface: a modal trigger, the first conversation, or a scroll) when the
            # composer isn't painted yet. It never commits a send, only opens a surface.
            p_reveal = os.environ.get("OSW_COMPOSER_REVEAL") == "1"
            # A reveal that OPENS the first list item (a Reddit thread, a TikTok video, a GitHub
            # issue) is a full-page NAVIGATION: it kills the finder's own JS context, so that one
            # call can't reach the composer that only exists on the destination. When the finder
            # reports it fired `open-first` but found nothing, the page is now loading the item;
            # give it a beat and run the finder ONCE more on the destination. Bounded to 2 tries so
            # a feed-of-feeds can't walk forever.
            fc: Dict[str, object] = {}
            for attempt in range(2):
                fc = await execute_tool("BrowserFindComposer", {"fill": payload, "reveal": p_reveal}, browser_id, tab_id)
                if isinstance(fc, dict) and fc.get("found") and fc.get("filled"):
                    break
                revs = fc.get("reveals") if isinstance(fc, dict) else None
                navigated = p_reveal and isinstance(revs, list) and "open-first" in revs
                if not navigated:
                    break
                logger.info("[browser-sendscript] reveal navigated (open-first); re-perceiving the destination")
                await asyncio.sleep(1.5)
                dest = await fresh_list()
                # open-first can land on a login redirect (a logged-out feed's first item);
                # stop before the NEXT fill so we never type into the auth form we just opened.
                if looks_like_login_wall("", dest):
                    logger.info("[browser-sendscript] decline: reveal landed on a login/auth wall")
                    fc = {}
                    break
            if isinstance(fc, dict) and fc.get("found") and fc.get("filled"):
                p_struct_selector = str(fc.get("selector") or "")
                logger.info(f"[browser-sendscript] structural composer role={fc.get('role')!r} "
                            f"score={fc.get('score')} nearSubmit={fc.get('nearSubmit')} "
                            f"reveals={fc.get('reveals')} fillMode={fc.get('fillMode')} filled+verified")
                log.append({"tool": "BrowserFindComposer", "input": {"fill": "<payload>"}, "ok": True,
                            "result_summary": f"structural composer {fc.get('role')!r} filled+verified"[:200], "elapsed_ms": 0})
                composer = (-1, str(fc.get("role") or "composer"))
            else:
                logger.info(f"[browser-sendscript] structural finder: no usable composer ({str(fc)[:120]})")
        if not composer:
            logger.info("[browser-sendscript] decline: no composer, opener, or structural editable")
            return None
    # No Send-button precondition: composer sites (LinkedIn) lazy-render Send only AFTER text commits, so it's resolved post-fill; never appearing = clean pre-click abort.
    logger.info(f"[browser-sendscript] fill target {composer[1]!r} [{composer[0]}]")

    if p_struct_selector:
        # The finder already filled + read-back-verified in-page; nothing to re-fill or re-check.
        state2 = await fresh_list()
        committed = True
    else:
        # 1. fill (focused by node, the composer overlay path coordinate clicks miss)
        r_fill = await execute_tool("BrowserClickIndex", {"index": composer[0], "text": payload}, browser_id, tab_id)
        fill_ok = isinstance(r_fill, dict) and "error" not in r_fill
        log.append({"tool": "BrowserClickIndex", "input": {"index": composer[0], "text": payload},
                    "ok": fill_ok, "result_summary": f"script fill into {composer[1]!r}"[:200], "elapsed_ms": 0})
        if not fill_ok:
            logger.info("[browser-sendscript] fill errored; handing to model untouched")
            return None
        # 2. verify the fill committed. Send is resolved AFTER, two ways: LinkedIn enables Send only once its JS digests the input (beats later than the text is visible), so the scan waits a little.
        state2 = ""
        committed = False
        for wait_s in (0.4, 0.8, 1.2, 1.6):
            await asyncio.sleep(wait_s)
            state2 = await fresh_list()
            committed = bool(state2 and payload_in_textbox(state2, payload))
            if committed:
                break
        if not committed:
            logger.info("[browser-sendscript] fill not seen committed; aborting pre-click")
            return None
    # Dry-run probe: prove the script FIRES + fills on a NON-LinkedIn site without ever
    # doing the outward send. Everything up to here ran (surface gate passed, composer
    # found, fill committed); we stop before the irreversible click and report readiness.
    if os.environ.get("OSW_SENDSCRIPT_DRYRUN") == "1":
        send_ready = bool(send_index_in_state(state2, composer[0]))
        logger.info(f"[browser-sendscript] DRYRUN: WOULD send (fill committed, send_button_listed={send_ready}); not clicking")
        return {"sent": False, "payload": payload, "log": log,
                "note": "DRYRUN: filled + ready to send, stopped before the irreversible click"}
    # 3+4: the irreversible click + two-sided receipt, shared with the mid-loop takeover. A click error hands back to the model (fill committed, not sent); a clicked-but-unverified send returns sent=False so the caller never claims delivery.
    r = await complete_send(payload, state2, browser_id, tab_id, execute_tool, send_index_in_state,
                            composer_index=composer[0])
    log.extend(r["log"])
    if not r["clicked"]:
        logger.info("[browser-sendscript] send click errored; handing to model (fill committed, NOT sent)")
        return None
    logger.info(f"[browser-sendscript] done sent_receipt={r['sent']} in {int((time.monotonic() - t0) * 1000)}ms")
    return {"sent": bool(r["sent"]), "payload": payload, "log": log, "note": str(r["note"])}
