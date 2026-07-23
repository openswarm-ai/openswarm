"""
Navigation pre-stage: before the big model wakes, a cheap aux model drives
NAVIGATE/CLICK-only steps on the live webview until the page is where the main
agent only has to do the final content action (read the answer, type into an
open composer). Deletes the 4-6 cold orientation turns from the big loop; the
big model starts staged instead of exploring at ~3s a thought.

Safety is code, not prose: the only tools this module can issue are
BrowserNavigate and BrowserClickIndex, and a click whose listed element text
smells irreversible (send/submit/pay/...) is refused in code, ending the
pre-stage so the main loop's full guard stack owns that step.
"""

import asyncio
import logging
import os
import re
import time
from typing import Awaitable, Callable

logger = logging.getLogger(__name__)

MAX_STEPS = 4
STEP_TIMEOUT_S = 8.0
TOTAL_TIMEOUT_S = 25.0
# Opener mode reaches one hop deeper (a post/comment surface is often nav -> open item -> reveal box).
OPENER_MAX_STEPS = 6
OPENER_TOTAL_TIMEOUT_S = 32.0

P_STEP_RE = re.compile(r"^\s*(NAVIGATE|CLICK|READY)\b[:\s]*(.*)$", re.I)

# URL shapes that mean "a list of candidates to pick from" (also drives the agent's candidate scan)
RESULTS_URL_RE = re.compile(
    r"[?&](q|query|keywords|search|search_query|find|term)=|/search\b|/results\b", re.I,
)
P_BLOCKED_CLICK_RE = re.compile(
    r"\b(send|submit|post|pay|buy|order|delete|confirm|apply|accept|invite|"
    r"connect|purchase|checkout|subscribe|unfollow|sign\s?out|log\s?out)\b",
    re.I,
)
# Genuinely irreversible / costly: NEVER a composer-opener, refused in every mode.
P_HARD_BLOCK_RE = re.compile(
    r"\b(send|submit|pay|buy|order|delete|confirm|apply|accept|invite|"
    r"connect|purchase|checkout|subscribe|unfollow|sign\s?out|log\s?out)\b",
    re.I,
)
# Compose-ENTRY words: on a composer-ABSENT page these OPEN a box (X/Threads "Post",
# Reddit "Create Post", "Add a comment", "Reply", "New thread"); the SAME word is the
# submit once a box exists. So allowed only while no composer is in perception.
P_COMPOSE_ENTRY_RE = re.compile(r"\b(post|comment|reply|tweet|write|thread|note|caption)\b", re.I)


def opener_mode() -> bool:
    """Whether prestage may OPEN a composer (click a person's Message / a 'Reply'/'Post'
    surface) instead of only navigating to an already-open one. It's ON when its own flag is
    set OR when the send-script is enabled: the send-script can only fire once a composer is
    reached, and the opener is what reaches it, so they're a pair (a send-script run that
    lands on a search page with no opener just declines and burns the slow model loop, the
    exact miss we measured). Safe by construction: the opener never types and refuses any
    send/submit/pay word, so a worst-case mis-click opens an empty box, never sends."""
    if os.environ.get("OSW_PRESTAGE_OPENER", "0") != "0":
        return True
    from backend.apps.agents.browser.browser_send_script import script_enabled
    return script_enabled()


def click_refused(entry: str, li_text: str) -> bool:
    """Whether prestage must refuse this click. Opener-mode-off = the legacy blanket
    gate (Phase A byte-identical). Opener-mode-on = structural: hard-irreversible
    words refused always; a compose-entry word (post/comment/reply/...) refused ONLY
    when a composer textbox is ALREADY in the current perception (then it's the real
    submit), allowed when none is present (then the click REVEALS the composer).
    Prestage never types, so even a worst-case mis-click submits empty content."""
    if not opener_mode():
        return bool(P_BLOCKED_CLICK_RE.search(entry))
    if P_HARD_BLOCK_RE.search(entry):
        return True
    if P_COMPOSE_ENTRY_RE.search(entry):
        from backend.apps.agents.browser.browser_send_parse import composer_index_in_state
        return bool(composer_index_in_state(li_text or ""))
    return False


P_SYSTEM_OPENER = (
    "You pre-stage a browser for a main agent. Using ONLY navigation and clicks "
    "that OPEN or REVEAL a composer, get the page to where a text box is visible "
    "and the main agent only has to type the content and submit.\n"
    "OPENING a composer IS your job: click 'Start a post' / 'Create post' / 'New "
    "thread' / the compose 'Post' or 'Tweet' button / 'Add a comment' / 'Reply' / "
    "a person's 'Message' button so the text box appears.\n"
    "The MOMENT a compose text box is visible in the elements, reply READY, the "
    "stage is set.\n"
    "NEVER submit: do not click Send, Submit, Pay, Buy, Order, Delete, Confirm, "
    "Subscribe, or Connect. If the only next step is typing or the final submit, "
    "reply READY.\n"
    "For a task that messages a PERSON: go to that person (search result, "
    "profile), then open their Message surface. For a comment/reply on a thread "
    "or video: open the item, then reveal the comment box.\n"
    "Reply with exactly ONE line:\n"
    "NAVIGATE <absolute url>\n"
    "CLICK <index>\n"
    "READY <short reason>\n"
    "If unsure, reply READY."
)

P_SYSTEM = (
    "You pre-stage a browser for a main agent. Using ONLY navigation (opening "
    "pages, clicking links or buttons that open/reveal things), get the page to "
    "the state where the main agent only has to do the FINAL content action "
    "(read the requested info, or type into an already-open composer/form).\n"
    "NEVER click anything that sends, submits, posts, pays, buys, deletes, "
    "accepts, connects, or subscribes. Opening a composer (e.g. a 'Message' "
    "button) is allowed; pressing its Send is not. If the next needed step is "
    "typing text or an irreversible click, the stage is set.\n"
    "For a task about a specific PERSON or THING (message them, read their "
    "details): click through to that person/thing's OWN page first; a "
    "search-results list is NOT the staged page. For messaging, then open "
    "their Message/compose surface; never detour to a feed or homepage. When "
    "several people share the name, a direct/1st-degree connection outranks "
    "every other cue (title, company, verified): people ask about people "
    "they know.\n"
    "Reply with exactly ONE line:\n"
    "NAVIGATE <absolute url>\n"
    "CLICK <index>\n"
    "READY <short reason>\n"
    "If unsure, reply READY."
)

ToolRunner = Callable[[str, dict, str, str], Awaitable[dict]]


def prestage_enabled() -> bool:
    return os.environ.get("OSW_PRESTAGE", "1") != "0"


def list_entry_for(list_text: str, index: int) -> str:
    for line in (list_text or "").splitlines():
        if line.strip().startswith(f"[{index}]"):
            return line.strip()
    return ""


def parse_step(reply: str) -> tuple[str, str]:
    m = P_STEP_RE.match((reply or "").strip().splitlines()[0] if reply else "")
    if not m:
        return "ready", ""
    return m.group(1).lower(), m.group(2).strip()


def perception_block(li_text: str, gt_text: str, stage_note: str = "") -> str:
    parts = []
    if li_text:
        parts.append("Interactive elements already on the page:\n" + li_text)
    if gt_text:
        parts.append("Visible page text (truncated):\n" + gt_text[:2000])
    if not parts:
        return ""
    return (
        "\n\n[Page already loaded and inspected for you, act directly; "
        "no need to screenshot or list elements again unless it changes]\n"
        + (f"{stage_note}\n" if stage_note else "")
        + "\n\n".join(parts)
    )


def stage_note_for(start_url: str, done: list[str], current_url: str, complete: bool) -> str:
    """Without this the main model re-verifies the route from scratch (observed:
    it navigated straight back to the start page), erasing the staging win. The
    note must never overclaim: a partial stage saying 'navigation DONE' sent the
    main loop on a 27-turn walkabout (observed live)."""
    if not done:
        return ""
    if complete:
        return (
            f"[Pre-staged for you and VERIFIED: starting from {start_url or 'the entry page'}, "
            f"already performed: {'; '.join(done)}. You are NOW on {current_url}. The "
            "navigation part of the task is DONE, do not go back or re-verify it; "
            "perform only the remaining final action(s). Staged runs took 7 solo turns "
            "where 2 suffice: if the remaining work is composing, use ONE BrowserBatch to "
            "focus the box and type the text, then the Send/Submit click SOLO with expect. "
            "Do not re-list first; the elements are listed below.]"
        )
    return (
        f"[Partial pre-staging: already performed {'; '.join(done)}. You are NOW on "
        f"{current_url}. Continue from HERE (do not restart from the beginning); "
        "finish the remaining navigation and the task yourself.]"
    )


async def run_prestage(
    task: str,
    browser_id: str,
    tab_id: str,
    start_url: str,
    settings,
    primary_api: str | None,
    execute_tool: ToolRunner,
    perceive_only: bool = False,
) -> tuple[str, str, list[dict]]:
    """(perception_block, current_url, action_records); ('', start_url, [])
    means nothing staged and the caller proceeds exactly as before.
    perceive_only skips the aux navigation loop and just captures the page: the
    caller has a verified click-through tier of its own (plan-dispatch), so the
    aux asks here were measured pure overhead (~2s) on that path."""
    t0 = time.monotonic()
    recs: list[dict] = []
    try:
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.agents.core.aux_llm import safe_resp_text

        aux_model, _ = await resolve_aux_model(settings, preferred_tier="haiku", primary_api=primary_api)
        client = get_anthropic_client_for_model(settings, aux_model)

        async def perceive() -> tuple[str, str, str]:
            li, gt = await asyncio.gather(
                execute_tool("BrowserListInteractives", {}, browser_id, tab_id),
                execute_tool("BrowserGetText", {}, browser_id, tab_id),
                return_exceptions=True,
            )
            li = li if isinstance(li, dict) else {}
            gt = gt if isinstance(gt, dict) else {}
            url = str(li.get("url") or gt.get("url") or "")
            li_text = str(li.get("text") or "") if "error" not in li else ""
            gt_text = str(gt.get("text") or "") if "error" not in gt else ""
            return li_text, gt_text, url

        current_url = start_url
        li_text, gt_text = "", ""
        steps = 0
        done_desc: list[str] = []
        seen_steps: set[tuple[str, str]] = set()
        staged_complete = False

        async def settle(pre_url: str, pre_text: str, pre_li: str) -> bool:
            # A click returns before the page swaps; perceiving too early reads the OLD page and the aux re-issues the same click (observed 4x loop). Wait for the page to actually change, capped. False = the action verifiably did NOT take. An overlay (message composer) changes the INTERACTIVES but not the URL and often not the first 400 chars of text, so the element list counts as change too.
            t_s = time.monotonic()
            while time.monotonic() - t_s < 3.0:
                await asyncio.sleep(0.35)
                li2, gt2, u2 = await perceive()
                if ((u2 and u2 != pre_url) or (gt2 and gt2[:400] != pre_text[:400])
                        or (li2 and pre_li and li2 != pre_li)):
                    return True
            return False
        p_max_steps = 0 if perceive_only else (OPENER_MAX_STEPS if opener_mode() else MAX_STEPS)
        p_total_timeout = OPENER_TOTAL_TIMEOUT_S if opener_mode() else TOTAL_TIMEOUT_S
        p_system = P_SYSTEM_OPENER if opener_mode() else P_SYSTEM
        p_results_overruled = False
        while steps < p_max_steps and (time.monotonic() - t0) < p_total_timeout:
            li_text, gt_text, seen_url = await perceive()
            current_url = seen_url or current_url
            reply = safe_resp_text(await asyncio.wait_for(
                client.messages.create(
                    model=aux_model, max_tokens=60, temperature=0, system=p_system,
                    messages=[{"role": "user", "content": (
                        f"Task: {task[:1500]}\n\nCurrent URL: {current_url}\n\n"
                        f"Interactive elements:\n{li_text[:4000]}\n\n"
                        f"Visible text (truncated):\n{gt_text[:1200]}"
                    )}],
                ),
                timeout=STEP_TIMEOUT_S,
            )).strip()
            verb, arg = parse_step(reply)
            if verb == "ready" or not arg:
                # A results LIST is never the staged page for a task about one specific person/thing; the aux accepts it about half the time (measured, 2/4 cold LinkedIn runs) and every downstream tier then declines. Overrule ONCE with a nudge re-ask; a second READY is accepted, some tasks really do target the list.
                if RESULTS_URL_RE.search(current_url or "") and not p_results_overruled:
                    p_results_overruled = True
                    task = task + (
                        "\n\n[You replied READY on a search-results LIST. If the task is about "
                        "one specific person or thing, CLICK through to its own page first; "
                        "READY again only if the task really is about this list.]")
                    continue
                staged_complete = True
                logger.info(f"[browser-prestage] READY after {steps} step(s): {arg[:80]}")
                break
            # Any revisit (not just consecutive) is a loop signal: an A/B nav flap slipped past the consecutive-only check.
            if (verb, arg) in seen_steps:
                logger.info(f"[browser-prestage] repeated step {verb} {arg[:40]!r}; stopping")
                break
            seen_steps.add((verb, arg))
            if verb == "navigate":
                if not arg.startswith(("http://", "https://")):
                    break
                r = await execute_tool("BrowserNavigate", {"url": arg}, browser_id, tab_id)
                ok = isinstance(r, dict) and "error" not in r
                recs.append({"tool": "BrowserNavigate", "input": {"url": arg}, "ok": ok,
                             "result_summary": str(r.get("text", r.get("error", "")))[:200] if isinstance(r, dict) else "",
                             "elapsed_ms": 0})
                logger.info(f"[browser-prestage] step {steps + 1}: nav {arg} ok={ok}")
                if not ok:
                    break
                if not await settle(current_url, gt_text, li_text):
                    logger.info(f"[browser-prestage] nav {arg} did not settle; stopping unstaged")
                    break
                done_desc.append(f"navigated to {arg}")
            else:
                try:
                    idx = int(re.sub(r"\D", "", arg) or "-1")
                except ValueError:
                    break
                entry = list_entry_for(li_text, idx)
                if idx < 0 or not entry or click_refused(entry, li_text):
                    logger.info(f"[browser-prestage] refusing click {idx} ({entry[:80]!r}); handing to main loop")
                    break
                r = await execute_tool("BrowserClickIndex", {"index": idx}, browser_id, tab_id)
                ok = isinstance(r, dict) and "error" not in r
                recs.append({"tool": "BrowserClickIndex", "input": {"index": idx}, "ok": ok,
                             "result_summary": entry[:200], "elapsed_ms": 0})
                logger.info(f"[browser-prestage] step {steps + 1}: click [{idx}] {entry[:60]!r} ok={ok}")
                if not ok:
                    break
                if not await settle(current_url, gt_text, li_text):
                    # The click ran but the page never changed (occluded element, overlay, stale index). Recording it would make the handoff note LIE ("navigation done") and send the main loop on a walkabout; observed live as 27-turn/112s regressions.
                    logger.info(f"[browser-prestage] click [{idx}] did not settle; stopping unstaged")
                    break
                done_desc.append(f"clicked {entry[:70]}")
            steps += 1

        if steps or not li_text:
            li_text, gt_text, seen_url = await perceive()
            current_url = seen_url or current_url
        # Perceive-only lost the aux asks that ACCIDENTALLY doubled as settle time, so a cold SPA hands back a half-hydrated list (measured: plan-dispatch emitted [] on a thin search page). Wait for substance, bounded.
        if perceive_only:
            p_sub_t0 = time.monotonic()
            while len(li_text or "") < 800 and time.monotonic() - p_sub_t0 < 4.0:
                await asyncio.sleep(0.8)
                li_text, gt_text, seen_url = await perceive()
                current_url = seen_url or current_url
        block = perception_block(li_text, gt_text, stage_note_for(start_url, done_desc, current_url, staged_complete))
        for tool_name, text in (("BrowserListInteractives", li_text), ("BrowserGetText", gt_text)):
            if text:
                recs.append({"tool": tool_name, "input": {}, "ok": True,
                             "result_summary": text[:200], "elapsed_ms": 0})
        logger.info(
            f"[browser-prestage] done: steps={steps}{' (perceive-only)' if perceive_only else ''} "
            f"url={current_url[:80]} in {int((time.monotonic() - t0) * 1000)}ms"
        )
        return block, current_url, recs
    except Exception as e:
        logger.info(f"[browser-prestage] skipped ({e})")
        return "", start_url, recs
