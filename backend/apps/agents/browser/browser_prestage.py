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

from backend.apps.agents.browser import browser_send_parse, compose_discovery, compose_entry
from backend.apps.agents.browser import first_item_of_type
from backend.apps.agents.browser.strip_lone_surrogates import strip_lone_surrogates

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
BLOCKED_CLICK_RE = re.compile(
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


def same_page(a: str, b: str) -> bool:
    """Whether two URLs address the page we are already on, ignoring only the parts a browser itself
    ignores when deciding it has not moved: a trailing slash and a #fragment. Query strings are NOT
    stripped, because ?q= is usually the whole difference between two pages."""
    def norm(u: str) -> str:
        u = (u or "").strip().split("#", 1)[0]
        return u[:-1] if u.endswith("/") else u
    p_a, p_b = norm(a), norm(b)
    return bool(p_a) and p_a == p_b


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
        return bool(BLOCKED_CLICK_RE.search(entry))
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
    task_is_send: bool = False,
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
            # Scrub here, the one door page text comes through: an unpaired surrogate (half an
            # emoji, and twitch chat is made of them) survives in Python but detonates the moment
            # the aux request is encoded, and the whole stage was dying in a blanket except.
            li_text = strip_lone_surrogates(str(li.get("text") or "")) if "error" not in li else ""
            gt_text = strip_lone_surrogates(str(gt.get("text") or "")) if "error" not in gt else ""
            return li_text, gt_text, url

        current_url = start_url
        li_text, gt_text = "", ""
        steps = 0
        done_desc: list[str] = []
        seen_steps: set[tuple[str, str]] = set()
        staged_complete = False

        async def open_composer_directly(url: str) -> bool:
            """Navigate to the site's own compose URL and confirm a composer actually appeared.

            The confirmation is the whole point. Without it this would be a per-site nav hardcode
            that strands the run wherever the URL happens to lead once a site changes it; with it,
            a miss costs one navigation and the aux loop below runs exactly as it does today."""
            nonlocal li_text, gt_text, current_url, staged_complete
            r = await execute_tool("BrowserNavigate", {"url": url}, browser_id, tab_id)
            ok = isinstance(r, dict) and "error" not in r
            recs.append({"tool": "BrowserNavigate", "input": {"url": url}, "ok": ok,
                         "result_summary": f"compose entry for {compose_entry.registrable_host(url)}"[:200],
                         "elapsed_ms": 0})
            if not ok:
                return False
            # This is a cold NAVIGATION into a single-page app, not a modal opening on a page that
            # is already up, so it gets a longer budget than the opener hop: the app has to boot
            # before the composer can exist. Bounded well inside the prestage timeout so a miss
            # still leaves room for the aux loop.
            p_boxes = 0
            p_prev = ""
            p_settled = 0
            for wait_s in (0.8, 1.2, 1.5, 2.0, 2.5, 2.5, 2.5):
                await asyncio.sleep(wait_s)
                li2, gt2, u2 = await perceive()
                if li2:
                    li_text, gt_text = li2, gt2
                    current_url = u2 or url
                # Same stop condition as the opener hop: wait while the page is still arriving,
                # give up the moment it stops changing. Measured on a loaded machine, x.com's
                # compose route reported ZERO textboxes after 8s (nothing had rendered at all, not
                # an ambiguous pick), while an idle machine had it in under two.
                # TWO identical reads, not one. Gmail's compose window paints To/Cc/Bcc/Subject
                # first and holds them steady for a beat while the body field is still arriving, so
                # a single stable read declared the page finished and we walked away from a
                # composer that was about to exist (measured: "saw 4 textbox(es) but no single
                # composer").
                p_settled = p_settled + 1 if li2 and li2 == p_prev else 0
                p_prev = li2
                # A signed-out visit to a compose URL redirects to sign-in, and a login form is
                # made of textboxes. Claiming "composer reached" there would tell the rest of the
                # run the navigation is done while it sits on an auth wall.
                if browser_send_parse.looks_like_login_wall(current_url, li2):
                    logger.info("[browser-prestage] compose entry landed on a sign-in wall; "
                                "not staged")
                    return False
                if browser_send_parse.composer_index_in_state(li2):
                    return True
                p_boxes = browser_send_parse.textbox_count(li2)
                if p_settled >= 2:
                    break
            # Name the miss. "No composer" covers three different problems with three different
            # fixes: the page never mounted one (0 boxes), we were too early (few boxes, still
            # hydrating), or several matched and the picker refused as ambiguous. Guessing between
            # them is how the last two rounds of timeout tuning made things worse.
            logger.info(f"[browser-prestage] compose entry saw {p_boxes} textbox(es) but no single "
                        f"composer at {current_url[:80]}")
            return False

        async def discover_compose_links(page_url: str) -> list[str]:
            """The site's own compose links, best first, or nothing.

            Failure is silent on purpose: this runs on whatever page the card happens to be on, so
            a page that blocks evaluation or publishes no such link must cost one read and leave the
            run exactly as it was."""
            # Read the links of the site the task is ABOUT, not whichever page the card was left
            # on. A cold run opens on a blank/search page, so the first attempt at this read
            # happened on google.com and correctly found nothing: the site was never visited.
            wanted = compose_entry.named_hosts(task, page_url)
            if not wanted:
                return []
            host = wanted[0]
            # The page the user named, not just its host: github's "New issue" lives on the repo,
            # and github.com/ publishes no compose link at all.
            target = compose_entry.named_page(task, host)
            if not (page_url or "").rstrip("/").startswith(target.rstrip("/")):
                nav = await execute_tool(
                    "BrowserNavigate", {"url": target}, browser_id, tab_id)
                if not (isinstance(nav, dict) and "error" not in nav):
                    return []
                # The links live in the app shell, which is not there the instant navigation
                # returns. One settle beat, not a ladder: if the shell is slower than this the aux
                # loop is the better remaining spend.
                await asyncio.sleep(1.5)
            try:
                raw = await execute_tool(
                    "BrowserEvaluate", {"expression": compose_discovery.discovery_expression()},
                    browser_id, tab_id)
            except Exception as exc:
                logger.info(f"[browser-prestage] compose discovery could not read the page ({exc})")
                return []
            found = compose_discovery.rank_candidates(
                compose_discovery.parse_page_read(raw), host)
            logger.info(f"[browser-prestage] compose discovery on {host} -> "
                        f"{found if found else 'no compose link published'}")
            return found

        # Composer reachability: when the task creates something top-level on a site that
        # publishes its own compose URL, ask for that URL instead of aux-hunting the button. This
        # is the 0/20 gap; the fill and receipt behind it were already proven. A hit also skips
        # the aux loop, so the cheap path and the reliable path are the same path.
        # Where the run BEGAN, before anything moved the card. A card keeps the last URL it was
        # left on, so a run can inherit a composer some earlier run opened and look like a win it
        # never earned; without this line there is no way to tell those apart after the fact.
        logger.info(f"[browser-prestage] start url={(start_url or '(none)')[:120]}")
        p_compose_url = "" if perceive_only else (
            compose_entry.compose_entry_for(task, start_url, task_is_send) or "")
        if p_compose_url:
            if await open_composer_directly(p_compose_url):
                staged_complete = True
                done_desc.append(f"opened the composer at {p_compose_url}")
                logger.info(f"[browser-prestage] compose entry {p_compose_url} reached a composer")
            else:
                logger.info(f"[browser-prestage] compose entry {p_compose_url} showed no composer; "
                            f"falling through to the aux loop")

        # No table row for this host. Ask the PAGE where its composer is instead: a site that has
        # one links to it ("Start a post", "Ask Question"), and reading that link is what makes this
        # work on a host nobody has written down. Measured 0/8 off-table before this tier existed.
        if (not staged_complete and not perceive_only and task_is_send
                and compose_discovery.enabled() and compose_entry.wants_top_level_compose(task)):
            for p_found in await discover_compose_links(current_url or start_url):
                if await open_composer_directly(p_found):
                    staged_complete = True
                    done_desc.append(f"opened the composer at {p_found}")
                    logger.info(f"[browser-prestage] discovered compose link {p_found} "
                                f"reached a composer")
                    break
                logger.info(f"[browser-prestage] discovered compose link {p_found} "
                            f"showed no composer")

        async def settle(pre_url: str, pre_text: str, pre_li: str) -> bool:
            """Wait for the page to actually change after an action, capped.

            Timed by the caller's log line: this polls with a full perceive each round, so it is a
            real share of prestage's cost, and separating it from the aux plan is what says whether
            the fix is a cheaper decision or a faster wait."""
            # A click returns before the page swaps; perceiving too early reads the OLD page and the aux re-issues the same click (observed 4x loop). Wait for the page to actually change, capped. False = the action verifiably did NOT take. An overlay (message composer) changes the INTERACTIVES but not the URL and often not the first 400 chars of text, so the element list counts as change too.
            # Probe FIRST, then back off: the old fixed 0.35s pre-sleep charged an 80ms swap what it charged the slowest page it was tuned for (a tier-0 hit spent 1469ms of its 3244ms here). Zero-probing is safe because every clause below demands evidence of CHANGE. Same checks, same 3.0s cap, better schedule.
            t_s = time.monotonic()
            for wait_s in (0.0, 0.12, 0.18, 0.25, 0.35, 0.5, 0.6, 1.0):
                if wait_s:
                    await asyncio.sleep(wait_s)
                if time.monotonic() - t_s >= 3.0:
                    break
                li2, gt2, u2 = await perceive()
                if ((u2 and u2 != pre_url) or (gt2 and gt2[:400] != pre_text[:400])
                        or (li2 and pre_li and li2 != pre_li)
                        # A page that HAS content is a settled page, whether or not it differs from
                        # what came before. Every clause above asks "is this different?", and on a
                        # fresh card the before-state is empty, so `pre_li` is falsy and a perfectly
                        # good load can satisfy none of them. Measured on disqus: the embed URL
                        # served 200, the nav landed, and settle returned ok=False after 3.4s, so
                        # prestage stopped unstaged and BrowserListInteractives was never called at
                        # all. That reads downstream as "no composer" when the truth is we never
                        # looked. Not a disqus quirk: any page that renders nothing like its own
                        # blank pre-state trips it.
                        or (li2 and not pre_li)):
                    return True
            return False
        p_max_steps = 0 if perceive_only else (OPENER_MAX_STEPS if opener_mode() else MAX_STEPS)
        p_total_timeout = OPENER_TOTAL_TIMEOUT_S if opener_mode() else TOTAL_TIMEOUT_S
        p_system = P_SYSTEM_OPENER if opener_mode() else P_SYSTEM
        p_results_overruled = False
        p_composer_overruled = False
        p_ctype_overruled = False
        p_first_item_tried = False
        while (not staged_complete and steps < p_max_steps
               and (time.monotonic() - t0) < p_total_timeout):
            # Per-step cost, broken out. Prestage is the largest single phase of a LinkedIn write
            # (measured 18.6s of a 50.6s run, more than the send itself), and "steps=2 in 18587ms"
            # cannot tell you whether that is the aux deciding, the page settling, or the click.
            # Those have completely different fixes, so the log has to separate them.
            p_t_step = time.monotonic()
            li_text, gt_text, seen_url = await perceive()
            p_t_perceive = time.monotonic() - p_t_step
            current_url = seen_url or current_url
            # TIER 0: the box is already here, so there is nothing to discover and no reason to ask.
            # Staged means "a composer is visible", which this perception just answered directly; the
            # aux call below can only agree with it, and it costs 1.7-6.5s to do so. That call was
            # the whole cost of a steps=0 run: 4.6s median where the page was ready the entire time.
            # The model stays exactly where it belongs, as the fallback for pages that need finding.
            if task_is_send and browser_send_parse.composer_index_in_state(li_text):
                staged_complete = True
                logger.info(f"[browser-prestage] READY tier-0 in "
                            f"{int((time.monotonic() - p_t_step) * 1000)}ms: a composer is already "
                            f"on the page, no aux call needed")
                break
            # TIER 1: the task asked for the FIRST <thing>, and the page's own links say which ones
            # are that thing. Instagram posts are /p/, tiktok videos /video/, youtube /watch. Picking
            # the first matching link is deterministic; asking a model to find it in a feed is not,
            # and that is where instagram kept going wrong (1/10, 3/5, 0/5, 0/5 across four windows,
            # landing in the stories viewer, on a profile, or nowhere). Costs one evaluate against
            # the 1.7-6.5s aux call it replaces, and it can only ever choose a URL the downstream
            # wrong-surface guard would also accept, because both read the same type patterns.
            if task_is_send and not p_first_item_tried:
                p_first_item_tried = True
                p_want = first_item_of_type.wanted_type(task)
                p_expr = first_item_of_type.first_link_expression(p_want) if p_want else ""
                if p_expr and not browser_send_parse.content_type_mismatch(task, current_url):
                    try:
                        p_r = await asyncio.wait_for(
                            execute_tool("BrowserEvaluate", {"expression": p_expr},
                                         browser_id, tab_id), timeout=6.0)
                        p_href = str((p_r or {}).get("value") or (p_r or {}).get("text") or "").strip()
                    except Exception:
                        p_href = ""
                    if p_href.startswith("http") and p_href != current_url:
                        logger.info(f"[browser-prestage] tier-1: first {p_want} is {p_href[:70]}")
                        r = await execute_tool("BrowserNavigate", {"url": p_href}, browser_id, tab_id)
                        if isinstance(r, dict) and "error" not in r:
                            recs.append({"tool": "BrowserNavigate", "input": {"url": p_href},
                                         "ok": True, "result_summary": f"first {p_want}"[:200],
                                         "elapsed_ms": 0})
                            done_desc.append(f"opened the first {p_want}")
                            current_url = p_href
                            steps += 1
                            continue
            p_t_aux = time.monotonic()
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
            p_aux_ms = int((time.monotonic() - p_t_aux) * 1000)
            logger.info(f"[browser-prestage] step {steps + 1} plan: perceive={int(p_t_perceive * 1000)}ms "
                        f"aux={p_aux_ms}ms reply={reply[:40]!r}")
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
                # A send task is not staged until there is somewhere to write. Measured live: on
                # instagram the aux replies "I can see the Instagram home page is loaded" and calls
                # READY from the feed, and on tiktok it says "CLICK [1] READY" in one breath, before
                # the click it just asked for could open anything. Both then decline downstream with
                # composer=0 textboxes=0, having spent the whole stage. Same overrule shape as the
                # results-list rule above: nudge once, accept a second READY, because some surfaces
                # really do hide their box until the fill tier clicks an opener.
                if (task_is_send and not p_composer_overruled
                        and not browser_send_parse.composer_index_in_state(li_text)):
                    p_composer_overruled = True
                    task = task + (
                        "\n\n[You replied READY but no compose text box is listed in the elements. "
                        "OPEN the specific item the task names, on its own page, or CLICK the "
                        "control that reveals the box. READY again only once a textbox is listed.]")
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
                # Navigating to the page we are already on cannot stage anything, and it is not free: the command runs, then settle() compares against that same URL, finds nothing changed and burns its full 3s cap before reporting unstaged. Measured 2026-08-06 on dpaste, where the aux proposed back the entry URL it had just been handed. Same no-progress signal seen_steps catches, one round earlier and ~3s cheaper.
                if same_page(arg, current_url):
                    logger.info(f"[browser-prestage] nav {arg[:60]} is the page we are on; "
                                f"no progress, stopping unstaged")
                    break
                r = await execute_tool("BrowserNavigate", {"url": arg}, browser_id, tab_id)
                ok = isinstance(r, dict) and "error" not in r
                recs.append({"tool": "BrowserNavigate", "input": {"url": arg}, "ok": ok,
                             "result_summary": str(r.get("text", r.get("error", "")))[:200] if isinstance(r, dict) else "",
                             "elapsed_ms": 0})
                logger.info(f"[browser-prestage] step {steps + 1}: nav {arg} ok={ok}")
                if not ok:
                    break
                p_t_settle = time.monotonic()
                p_settled = await settle(current_url, gt_text, li_text)
                logger.info(f"[browser-prestage] step {steps + 1} nav settle={int((time.monotonic() - p_t_settle) * 1000)}ms ok={p_settled}")
                if not p_settled:
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
                p_t_settle = time.monotonic()
                p_settled = await settle(current_url, gt_text, li_text)
                logger.info(f"[browser-prestage] step {steps + 1} click settle={int((time.monotonic() - p_t_settle) * 1000)}ms ok={p_settled}")
                if not p_settled:
                    # The click ran but the page never changed (occluded element, overlay, stale index). Recording it would make the handoff note LIE ("navigation done") and send the main loop on a walkabout; observed live as 27-turn/112s regressions.
                    logger.info(f"[browser-prestage] click [{idx}] did not settle; stopping unstaged")
                    break
                done_desc.append(f"clicked {entry[:70]}")
                # Landing on the wrong KIND of thing is a navigation mistake, and it is cheapest
                # to catch here, while steps remain to correct it. Measured on instagram at N=5, all
                # five identical: the story-first feed sent prestage into instagram.com/stories/
                # <user>/, whose reply box IS a real composer, so the tier-0 check below would have
                # declared the stage READY and the send script then had to refuse ("asked for a
                # post, landed on a story"). The whole run was spent arriving somewhere the next
                # gate always rejects. One nudge only: some tasks legitimately land somewhere that
                # reads as another type, and the downstream guard still refuses a wrong surface.
                p_li_after, _, p_url_after = await perceive()
                p_ctype = browser_send_parse.content_type_mismatch(task, p_url_after or current_url)
                if p_ctype and not p_ctype_overruled:
                    p_ctype_overruled = True
                    logger.info(f"[browser-prestage] {p_ctype}; nudging back toward the right surface")
                    task = task + (
                        f"\n\n[You navigated somewhere that does not match the task: {p_ctype}. "
                        f"Go BACK and open the right kind of item instead.]")
                    steps += 1
                    continue
                # The click may BE the answer. settle() just re-perceived to prove the page changed,
                # so we already hold the new element list; asking the model whether a composer is now
                # visible costs 1.2-6.5s to re-read what we can read for free. Measured on ckeditor:
                # its demo lists a tab link and no textbox because the editor mounts lazily, prestage
                # clicked the tab, and then never looked again, so the send script never ran at all.
                # This is the tier-0 check applied AFTER a click as well as before one.
                if task_is_send and browser_send_parse.composer_index_in_state(p_li_after):
                    li_text = p_li_after
                    staged_complete = True
                    logger.info(f"[browser-prestage] READY tier-0 after click [{idx}]: the click "
                                f"revealed a composer, no further aux call needed")
                    steps += 1
                    break
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
