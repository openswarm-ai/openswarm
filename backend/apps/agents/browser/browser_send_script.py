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
    browser_verified_action, extract_payload)

logger = logging.getLogger(__name__)


ToolRunner = Callable[[str, dict, str, str], Awaitable[dict]]

# The worst case this routine can legitimately take, so the CALLER cannot starve it. Roughly: the
# composer poll (3 backoff waits plus three 6s interactive lists), one structural finder call (which
# carries its own 30s command timeout), then fill-and-commit and submit-and-receipt.
#
# This constant exists because the caller's timeout and this routine's real cost silently drifted
# apart: raising find_composer's command timeout from 15s to 30s made a single finder call able to
# eat the caller's entire 30s budget, so the whole script was killed mid-send and EVERY write fell
# back to the slow model loop. It failed invisibly, because asyncio.TimeoutError stringifies to
# nothing and the log read "outer skip ()". Measured live on LinkedIn: a 190.9s write that never
# posted. Import this instead of writing a number at the call site.
WORST_CASE_BUDGET_S = 75.0


def script_enabled() -> bool:
    """Default ON. Every gate below it fails CLOSED to the old model loop, so the worst case is
    today's behaviour, never a wrong send: the payload must be unambiguously quoted, the task must
    not read as a question, the surface must not be a login wall, a post task will not settle for a
    comment box, the fill must be seen committed, and delivery needs a two-sided receipt.
    Turning this off also disables the prestage opener and the mid-loop autosend takeover."""
    return os.environ.get("OSW_SEND_SCRIPT", "1") != "0"


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
        elif isinstance(p_v, dict) and p_v.get("disabled"):
            # The submit EXISTS and the site is refusing it, so there is nothing here a better
            # click could win: guessing at the literal "Send" would tap some other widget and the
            # cleared composer would read as delivery. Measured live on reddit's r/test/submit,
            # which is the whole shape of issue #94: its "post" button sits greyed out until the
            # title field is filled, and every run blind-tapped a coordinate and claimed success.
            # Handing back untouched is what lets the model do the one thing that CAN fix this,
            # fill the rest of the form, and it costs a run that was never going to send anyway.
            # The form is incomplete, and on a two-field form we can usually say WHICH field. The
            # composer we filled is the compose-shaped one (reddit's "Post text"); the one still
            # empty is what the submit is waiting on (reddit's "Title"). Fill that too and re-ask.
            # Measured: reddit's create-post flow could never complete, because the send path is
            # single-composer by construction and reddit needs a title before its submit enables.
            #
            # Deliberately narrow: EXACTLY one other empty textbox, so there is no guessing about
            # which field gets the payload, and the submit must ENABLE on its own afterwards. If it
            # stays disabled we fall through to the same honest hand-off as before, so the failure
            # mode is unchanged and nothing is ever clicked on a form the site still refuses.
            p_state = await fresh_list()
            # Exclude the composer BY INDEX, not by looking for the payload in the row: the row
            # regex captures the accessible NAME only, so a filled box and an empty one are
            # indistinguishable by name and every field would read as "still empty".
            p_empty = [(i, n) for i, n in browser_send_parse.P_COMPOSER_ROW_RE.findall(p_state)
                       if int(i) != composer_index
                       and not browser_send_parse.P_AUTH_FIELD_NAME_RE.search(n or "")]
            if len(p_empty) == 1:
                p_idx, p_name = int(p_empty[0][0]), p_empty[0][1]
                logger.info(f"[browser-sendscript] submit disabled and one field is still empty "
                            f"({p_name!r}); filling it and re-checking the submit")
                await execute_tool("BrowserClickIndex", {"index": p_idx, "text": payload},
                                   browser_id, tab_id)
                log.append({"tool": "BrowserClickIndex", "input": {"index": p_idx, "text": payload},
                            "ok": True, "clicked_role": "textbox", "clicked_name": p_name,
                            "result_summary": f"filled required field {p_name!r}"[:200],
                            "elapsed_ms": 0})
                r_ev2 = await execute_tool(
                    "BrowserEvaluate",
                    {"expression": browser_submit_click.container_submit_expression(payload)},
                    browser_id, tab_id)
                p_v2 = browser_submit_click.parse_eval_value(r_ev2)
                if isinstance(p_v2, dict) and p_v2.get("ok") and p_v2.get("xPct") is not None:
                    logger.info("[browser-sendscript] the submit enabled once the required field was filled")
                    r_send = await execute_tool(
                        "BrowserClickPoint",
                        {"xPercent": float(p_v2["xPct"]), "yPercent": float(p_v2["yPct"])},
                        browser_id, tab_id)
                    send_name = str(p_v2.get("name") or "submit")
                    via = "container-after-required-field"
                    p_v = p_v2
            if via == "index" and not (isinstance(p_v, dict) and p_v.get("ok")):
                logger.info(f"[browser-sendscript] submit {str(p_v.get('name'))!r} is present but DISABLED; "
                            f"the form is incomplete, handing to the model without clicking anything")
                return {"clicked": False, "sent": False, "log": log,
                    "note": (f"The {str(p_v.get('name')) or 'submit'} button is visible but disabled, so this "
                             f"form is not ready to send: something it requires is still empty (often a "
                             f"title or subject), or the editor never registered the typed text. Fill the "
                             f"remaining fields, then send. Nothing was clicked and nothing was posted.")}
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
    # Name WHY a receipt fails. A withheld receipt costs the whole fast path (measured on LinkedIn:
    # the script finished in 9.7s, the receipt missed, and the model then spent 28.6s re-verifying a
    # post that HAD landed, 60s total against ~24s when the receipt passes), and "sent_receipt=False"
    # alone cannot tell you whether the composer still holds the text or we simply could not read the
    # page. Those are different bugs with different fixes.
    # The tail is long because the loop RETURNS on the first clear: a site that clears instantly
    # exits at the 0.0 probe and pays none of it, so this window costs time only where we would
    # otherwise emit a false negative. Measured live on LinkedIn, every round of a 3-round canary:
    # the post LANDED (an independent read of the activity feed found it) while the composer still
    # held the text at 2.6s, so the old window called a real send unverified. That is not a harmless
    # miss; it sends the model back to re-verify a post that already succeeded, 60s against ~24s.
    p_why = "no-poll"
    p_waits = (0.0, 1.0, 1.6, 2.0, 3.0)
    for wait_s in p_waits:
        await asyncio.sleep(wait_s)
        state3 = await fresh_list()
        if not state3:
            p_why = "unreadable-list"
            continue
        if browser_verified_action.expectation_met(f"cleared:{payload}", state_committed, state3):
            sent = True
            break
        p_why = f"payload-still-in-a-textbox (textbox rows={sum(1 for x in state3.splitlines() if '<textbox' in x)})"
    if not sent:
        logger.info(f"[browser-sendscript] receipt withheld after {sum(p_waits):.1f}s of polling: {p_why}")
    # A cleared composer is proof of delivery everywhere EXCEPT the ghost-drop hosts, which clear
    # then silently eat the post; there we verify it persisted. delivered stays None (unchecked,
    # composer-clear trusted) for every other site, so proven sends keep their exact speed.
    delivered = None
    rejected = False
    # The site gets the first word. A cleared composer plus "Something went wrong" is a REFUSAL, and
    # trusting the clear there is how the agent ends up announcing a post that never existed.
    if sent and await browser_delivery_check.send_rejected(browser_id, tab_id, execute_tool):
        rejected, delivered, sent = True, False, False
        logger.info("[browser-sendscript] composer cleared but the page announced a failure; "
                    "treating as REJECTED, not delivered")
    elif sent and browser_delivery_check.is_ghost_drop_host(current_url):
        delivered = await browser_delivery_check.ghost_delivery_confirmed(
            payload, browser_id, tab_id, execute_tool)
    elif sent and via == "by-name":
        # The by-name click is the ONE path where we never actually located the submit: both
        # structured resolvers failed, so the literal "Send" is a guess, and it can land on some
        # OTHER widget's Send while this composer closes anyway. Measured live on LinkedIn's feed
        # composer (whose submit is "Post", not "Send"): sent_receipt=True and nothing posted, on
        # either the posts or the comments tab. A cleared composer cannot tell submitted from
        # dismissed, so a guessed click does not get to be proof by itself; it has to show the
        # payload actually rendered on the page. The two resolved paths are untouched and keep
        # their measured speed.
        delivered = await browser_delivery_check.payload_visible(
            payload, browser_id, tab_id, execute_tool)
        if delivered is False:
            logger.info("[browser-sendscript] by-name click cleared the composer but the payload "
                        "never rendered; treating as NOT delivered")
        elif delivered is None:
            # We could not look. That is not the same as looking and finding nothing, and saying
            # "it did not render" here would be inventing a failure out of a broken probe.
            logger.info("[browser-sendscript] by-name click cleared the composer but the delivery "
                        "probe was unreadable; leaving delivery UNKNOWN")
    if rejected:
        # We are not guessing here: the page said no. Saying "unverified" would send the user off to
        # check something we already know the answer to.
        note = browser_delivery_check.rejected_send_note(current_url, payload)
    elif sent:
        note = ""
    else:
        note = ("A Send-class click already RAN for this payload but the composer state is "
                "unverified: verify on the page whether it delivered; do NOT send again unless "
                "verifiably absent.")
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
    extract_payload_fn=None,
    current_url: str = "",
) -> dict | None:
    """None = stage not script-ready or aborted pre-click (model path, stage
    untouched except a possibly committed fill, which the model sees). A dict
    means the irreversible click RAN: {'sent': bool_receipt_verified,
    'payload': str, 'log': [...], 'note': str}. payload_source is the RAW user
    prompt; the composed task carries the routing brief whose own quoted strings
    made every real payload look ambiguous (r242/r243)."""
    t0 = time.monotonic()
    # Default ON, but the number that justified it was inflated: "composer reach 3/9 -> 6/9" counted
    # instagram's DM box (a wrong surface, now refused) and a twitch win that did not reproduce on a
    # clean re-sweep. Honest re-measure over the same 9 signed-in sites: 3/9 -> 4/9 composer, 2/9 ->
    # 3/9 submit, and youtube is the only site this tier reliably wins. Kept on because it cannot
    # loosen safety (every downstream gate is unchanged) and costs one page scan where there is none.
    p_struct = os.environ.get("OSW_COMPOSER_STRUCT", "1") != "0"

    # current_url is prestage's, frozen before any opener click or reveal navigation, so on exactly
    # the sites where a send goes somewhere surprising it names the wrong page. Track what we last
    # actually looked at instead.
    p_live_url = current_url

    async def fresh_list() -> str:
        nonlocal p_live_url
        try:
            r = await asyncio.wait_for(
                execute_tool("BrowserListInteractives", {}, browser_id, tab_id), timeout=6.0)
            if not (isinstance(r, dict) and "error" not in r):
                return ""
            p_live_url = str(r.get("url") or "") or p_live_url
            return str(r.get("text") or "")
        except Exception:
            return ""

    # The name-based surface gate can't see an unnamed/non-standard composer; under the
    # structural flag, don't early-decline on it, the in-page finder gets a chance below.
    if not browser_send_parse.surface_supports_script(current_url, state_text) and not p_struct:
        # The composer lazy-renders a beat after prestage snapshotted (X home does this ~half the
        # time), so poll a fresh perception before declining, else a late box is a false "no
        # composer" and the whole write flakes to the slow model path.
        for wait_s in (0.0, 1.0, 1.4):
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
    p_wall = browser_send_parse.login_wall_reason(current_url, state_text)
    if p_wall:
        logger.info(f"[browser-sendscript] decline: login/auth wall ({(current_url or '')[:60]!r}) "
                    f"triggered by {p_wall}")
        return None
    payload = browser_send_parse.quoted_payload(payload_source or task)
    if not payload and extract_payload_fn is not None:
        # Nobody types quotes. "send hi to charles zheng on linkedin" is how people actually ask,
        # and it fell to the slow path every time: measured live, that exact task made two
        # navigation clicks, three reads, typed nothing, and then reported a send it never made.
        # Deciding WHICH words is a judgement call, so it goes to the aux model; every safety gate
        # below is unchanged and still runs against whatever comes back. The model picks the text,
        # the code still refuses to claim anything it cannot watch happen.
        p_src = payload_source or task_sans_brief
        if extract_payload.looks_extractable(p_src):
            try:
                payload = await asyncio.wait_for(extract_payload_fn(p_src), timeout=8.0) or ""
            except Exception:
                payload = ""
            if payload:
                logger.info(f"[browser-sendscript] payload extracted from an unquoted ask: "
                            f"{payload[:60]!r}")
    if not payload:
        logger.info("[browser-sendscript] decline: no unambiguous quoted payload")
        return None
    # The page itself says what it is, and a composer on the wrong thing is still the wrong thing.
    # Live on instagram: a "comment on the first post" task opened a STORY, whose reply box is a
    # perfectly real composer, so every gate below passed and the comment would have gone somewhere
    # nobody asked for. Declining costs the fast path and hands the page to the model, which can
    # navigate; filling would have been silent and wrong.
    p_ctype = browser_send_parse.content_type_mismatch(task_sans_brief, current_url or "")
    if p_ctype:
        logger.info(f"[browser-sendscript] decline: {p_ctype} ({(current_url or '')[:60]})")
        return None
    log: list[dict] = []

    composer = browser_send_parse.composer_index_in_state(state_text)
    if composer and browser_send_parse.surface_mismatch(task_sans_brief, composer[1]):
        # Asked to POST and found a COMMENT box, or found a DM box nobody asked for: either way it
        # is someone else's surface, not a slower route to ours. Drop it and let the tiers below
        # (opener, then the structural finder, which does find LinkedIn's real composer) look properly.
        logger.info(f"[browser-sendscript] ignoring composer {composer[1]!r}: wrong surface for this task")
        composer = None
    if not composer:
        # The staged snapshot is prestage's, frozen the instant it clicked Message; the overlay composer lazy-renders a beat later (r263/r269 declined on exactly this, prestage's LAST step was the Message click). Poll a short window so the overlay has time to appear before we fall back to the opener.
        for wait_s in (0.0, 1.2, 1.4):
            await asyncio.sleep(wait_s)
            fresh = await fresh_list()
            composer = browser_send_parse.composer_index_in_state(fresh)
            if composer:
                state_text = fresh
                break
    p_struct_selector: str = ""
    if not composer:
        # Reversible-opener hop: prestage often stops on the profile with the "Message" opener visible (its settle raced the overlay). Opening a composer is the allowed opener class; the irreversible bar is unchanged.
        opener = browser_send_parse.opener_index_in_state(state_text, task_sans_brief)
        if opener and browser_send_parse.surface_mismatch(task_sans_brief, opener[1]):
            # The same wrong-surface rule the composer already enforces, applied one step earlier.
            # Measured on linkedin.com with "start a post": the only opener listed was 'Comment', so
            # the script opened a stranger's comment box, found no post composer inside it, and
            # declined. Measured on instagram.com with "write a comment on the first post": the
            # opener taken was the profile's 'Message', which is a DM to that person. Opening the
            # wrong surface is not a slower route to the right one, and it burns the one reversible
            # opener hop we get.
            logger.info(f"[browser-sendscript] ignoring opener {opener[1]!r}: wrong surface for this task")
            opener = None
        if opener:
            logger.info(f"[browser-sendscript] firing via opener {opener[1]!r} [{opener[0]}]")
            r_open = await execute_tool("BrowserClickIndex", {"index": opener[0]}, browser_id, tab_id)
            if not (isinstance(r_open, dict) and "error" not in r_open):
                return None
            # clicked_name/clicked_role are the fields the skill distiller reads. Putting the
            # element's name only into result_summary prose is why that layer recorded nothing in 95
            # consecutive gate passes: distill_steps hits a click it cannot name, truncates there,
            # and the navigation-only remainder is then correctly refused by its own guard.
            log.append({"tool": "BrowserClickIndex", "input": {"index": opener[0]}, "ok": True,
                        "clicked_role": "button", "clicked_name": opener[1],
                        "result_summary": f"script opened composer via {opener[1]!r}"[:200], "elapsed_ms": 0})
            # Wait for the surface to STOP MOVING, not for a number of seconds. Fixed budgets kept
            # being wrong in both directions: 1.8s missed gmail and linkedin entirely, 5.3s still
            # missed a cold gmail compose window that existed a beat later, and simply making the
            # number bigger taxes every run that was never going to succeed. A mounting surface
            # keeps changing the element list; once two consecutive reads are identical, nothing
            # more is coming and more waiting is pure cost.
            p_prev = ""
            p_settled = 0
            for wait_s in (0.0, 1.2, 1.5, 2.0, 2.0, 2.0):
                await asyncio.sleep(wait_s)
                state_text = await fresh_list()
                composer = browser_send_parse.composer_index_in_state(state_text)
                if composer:
                    break
                p_settled = p_settled + 1 if state_text and state_text == p_prev else 0
                p_prev = state_text
                if p_settled >= 1:
                    logger.info("[browser-sendscript] opener surface settled with no composer; "
                                "not waiting out the rest of the budget")
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
            # Default ON with the same sweep behind it: youtube's comment box exists only after a
            # scroll and a click on its placeholder, so no amount of scanning a painted page finds
            # it, and it was the single site this tier won. Reveal never commits anything: it opens
            # a surface, and its HARDBLOCK list keeps it off send/submit/pay/delete controls.
            p_reveal = os.environ.get("OSW_COMPOSER_REVEAL", "1") != "0"
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
            # Name WHY. A site that withholds the composer because nobody is signed in is a
            # different problem from one whose composer we failed to find, and only the first is
            # fixable by the user (sign in once). Consulted only here, on the already-failed path.
            if browser_send_parse.looks_signed_out(state_text):
                logger.info("[browser-sendscript] decline: signed OUT (composer withheld, sign-in offered)")
            else:
                logger.info("[browser-sendscript] decline: no composer, opener, or structural editable")
            return None
    # No Send-button precondition: composer sites (LinkedIn) lazy-render Send only AFTER text commits, so it's resolved post-fill; never appearing = clean pre-click abort.
    logger.info(f"[browser-sendscript] fill target {composer[1]!r} [{composer[0]}] on {p_live_url[:90]}")

    if p_struct_selector:
        # The finder already filled + read-back-verified in-page; nothing to re-fill or re-check.
        state2 = await fresh_list()
        committed = True
    else:
        # 1. fill (focused by node, the composer overlay path coordinate clicks miss)
        r_fill = await execute_tool("BrowserClickIndex", {"index": composer[0], "text": payload}, browser_id, tab_id)
        fill_ok = isinstance(r_fill, dict) and "error" not in r_fill
        # Named for the distiller, same as the opener. The payload does NOT ride along: a
        # BrowserClickIndex distills to a BrowserClickByName carrying role and name only, so a
        # replay re-focuses this box and the send script fills it with the CURRENT text. Baking the
        # payload in here is how a replay would re-post last week's message.
        log.append({"tool": "BrowserClickIndex", "input": {"index": composer[0], "text": payload},
                    "ok": fill_ok, "clicked_role": "textbox", "clicked_name": composer[1],
                    "result_summary": f"script fill into {composer[1]!r}"[:200], "elapsed_ms": 0})
        if not fill_ok and browser_submit_click.is_stale_index_error(r_fill):
            # The opener click opens a modal that keeps re-rendering after we listed it, so the
            # composer node we resolved is already detached by the time the fill lands. Measured
            # live on x.com: 'Index 53 is not in the cached element map', on the exact run where
            # the script had correctly found opener 'Post' and target 'Post text'. Re-listing is
            # what the error itself prescribes, so take it once rather than surrendering a send
            # the script had already located. One retry only: a second failure is a different
            # problem and the model path is the right answer for it.
            # Poll, don't snapshot. A single re-list catches the composer only if the modal happens
            # to be settled at that instant; mid-churn it shows zero or two compose-shaped boxes,
            # composer_index_in_state returns None (ambiguous), and the retry used to give up
            # without a word. Measured: 5 successful retries in one arm, 0 in the next, same code,
            # purely on timing. Same poll shape the opener path already uses.
            composer_retry = None
            for wait_s in (0.0, 0.5, 1.0):
                if wait_s:
                    await asyncio.sleep(wait_s)
                state_retry = await fresh_list()
                composer_retry = browser_send_parse.composer_index_in_state(state_retry)
                if composer_retry:
                    break
            if not composer_retry:
                logger.info("[browser-sendscript] composer index went stale and did not re-resolve "
                            "within 1.5s of polling; handing to model")
            if composer_retry:
                logger.info(f"[browser-sendscript] stale composer index {composer[0]}; refreshed to "
                            f"{composer_retry[0]} and retrying the fill once")
                composer = composer_retry
                r_fill = await execute_tool(
                    "BrowserClickIndex", {"index": composer[0], "text": payload}, browser_id, tab_id)
                fill_ok = isinstance(r_fill, dict) and "error" not in r_fill
                log.append({"tool": "BrowserClickIndex",
                            "input": {"index": composer[0], "text": payload}, "ok": fill_ok,
                            "clicked_role": "textbox", "clicked_name": composer[1],
                            "result_summary": f"script fill retry into {composer[1]!r}"[:200],
                            "elapsed_ms": 0})
        if not fill_ok:
            # Name the cause. "fill errored" alone cannot tell a stale index from a detached node
            # from a site that refuses synthetic input, and those are three different fixes. Same
            # lesson as the bare TimeoutError that used to log "outer skip ()".
            p_err = r_fill.get("error") if isinstance(r_fill, dict) else type(r_fill).__name__
            logger.info(f"[browser-sendscript] fill errored ({str(p_err)[:160]}); "
                        f"handing to model untouched")
            return None
        # 2. verify the fill committed. Send is resolved AFTER, two ways: LinkedIn enables Send only once its JS digests the input (beats later than the text is visible), so the scan waits a little.
        state2 = ""
        committed = False
        # Probe FIRST, then back off. Every poll in this file used to sleep before its first look,
        # which charges a page that was ready instantly the same as the slowest one it was tuned for.
        # other_ms (wall minus model minus browser, the part we own) was 58% of the median run at
        # 2450ms, and these fixed pre-sleeps are the bulk of it. The tail is unchanged, so nothing
        # that needed the time loses it, and no work moves into another bucket: same check, better
        # schedule.
        for wait_s in (0.0, 0.8, 1.2, 1.6):
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
        # Resolve the submit too, WITHOUT clicking it: the resolver is a page read that hands back
        # coordinates, so a dry run can measure both halves of coverage (did we reach a composer AND
        # can we find its send) on the great majority of sites we are never allowed to post to.
        # Measuring only the fill is exactly how a resolver that could not find reddit's button hid
        # behind a passing suite: every dry sweep said "ready to send" about a send that would have
        # blind-tapped a coordinate.
        r_ev = await execute_tool(
            "BrowserEvaluate",
            {"expression": browser_submit_click.container_submit_expression(payload)}, browser_id, tab_id)
        p_v = browser_submit_click.parse_eval_value(r_ev)
        p_ok = bool(isinstance(p_v, dict) and p_v.get("ok"))
        p_named = (str(p_v.get("name") or "") if p_ok else
                   str(p_v.get("why") or "unreadable eval") if isinstance(p_v, dict) else "unreadable eval")
        logger.info(f"[browser-sendscript] DRYRUN: WOULD send (fill committed, "
                    f"send_button_listed={send_ready}, submit_resolved={p_ok}, "
                    f"submit_rank={p_v.get('rank') if p_ok else 0}, submit={p_named!r}); not clicking")
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
