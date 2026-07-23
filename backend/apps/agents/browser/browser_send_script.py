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
import logging
import os
import time
from typing import Awaitable, Callable, Dict

from backend.apps.agents.browser import (
    browser_delivery_check, browser_fast_path, browser_send_parse, browser_submit_click,
    browser_verified_action)

logger = logging.getLogger(__name__)


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
    composer_index: int = -1, current_url: str = "",
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
        # button): resolve the submit inside the composer's OWN container and click it with REAL
        # input (synthetic clicks are ignored by web-component sites), then last-resort by-name.
        r_ev = await execute_tool(
            "BrowserEvaluate",
            {"expression": browser_submit_click.container_submit_expression(payload)}, browser_id, tab_id)
        p_v = browser_submit_click.parse_eval_value(r_ev)
        if isinstance(p_v, dict) and p_v.get("ok") and p_v.get("xPct") is not None:
            r_send = await execute_tool(
                "BrowserClickPoint",
                {"xPercent": float(p_v["xPct"]), "yPercent": float(p_v["yPct"])}, browser_id, tab_id)
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
    # A cleared composer is proof of delivery everywhere EXCEPT the ghost-drop hosts, which clear
    # then silently eat the post; there we verify it persisted. delivered stays None (unchecked,
    # composer-clear trusted) for every other site, so proven sends keep their exact speed.
    delivered = None
    if sent and browser_delivery_check.is_ghost_drop_host(current_url):
        delivered = await browser_delivery_check.ghost_delivery_confirmed(
            payload, browser_id, tab_id, execute_tool)
    note = ("" if sent else
            "A Send-class click already RAN for this payload but the composer state is unverified: "
            "verify on the page whether it delivered; do NOT send again unless verifiably absent.")
    return {"clicked": True, "sent": sent, "delivered": delivered, "log": log, "note": note}


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
    if not browser_send_parse.surface_supports_script(current_url, state_text) and not p_struct:
        # The composer lazy-renders a beat after prestage snapshotted (X home does this ~half the
        # time), so poll a fresh perception before declining, else a late box is a false "no
        # composer" and the whole write flakes to the slow model path.
        for wait_s in (0.6, 1.0, 1.4):
            await asyncio.sleep(wait_s)
            fresh = await fresh_list()
            if browser_send_parse.surface_supports_script(current_url, fresh):
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
    if browser_send_parse.is_readonly(task_sans_brief) or (payload_source and browser_send_parse.is_readonly(payload_source)):
        logger.info("[browser-sendscript] decline: read-only directive in user request")
        return None
    if browser_send_parse.looks_like_login_wall(current_url, state_text):
        logger.info(f"[browser-sendscript] decline: login/auth wall ({(current_url or '')[:60]!r})")
        return None
    payload = browser_send_parse.quoted_payload(payload_source or task)
    if not payload:
        logger.info("[browser-sendscript] decline: no unambiguous quoted payload")
        return None
    log: list[dict] = []

    composer = browser_send_parse.composer_index_in_state(state_text)
    if not composer:
        # The staged snapshot is prestage's, frozen the instant it clicked Message; the overlay composer lazy-renders a beat later (r263/r269 declined on exactly this, prestage's LAST step was the Message click). Poll a short window so the overlay has time to appear before we fall back to the opener.
        for wait_s in (0.6, 1.2, 1.4):
            await asyncio.sleep(wait_s)
            fresh = await fresh_list()
            composer = browser_send_parse.composer_index_in_state(fresh)
            if composer:
                state_text = fresh
                break
    p_struct_selector: str = ""
    if not composer:
        # Reversible-opener hop: prestage often stops on the profile with the "Message" opener visible (its settle raced the overlay). Opening a composer is the allowed opener class; the irreversible bar is unchanged.
        opener = browser_send_parse.opener_index_in_state(state_text)
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
                composer = browser_send_parse.composer_index_in_state(state_text)
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
                if browser_send_parse.looks_like_login_wall("", dest):
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
                            composer_index=composer[0], current_url=current_url)
    log.extend(r["log"])
    if not r["clicked"]:
        logger.info("[browser-sendscript] send click errored; handing to model (fill committed, NOT sent)")
        return None
    logger.info(f"[browser-sendscript] done sent_receipt={r['sent']} delivered={r.get('delivered')} in {int((time.monotonic() - t0) * 1000)}ms")
    return {"sent": bool(r["sent"]), "delivered": r.get("delivered"),
            "payload": payload, "log": log, "note": str(r["note"])}
