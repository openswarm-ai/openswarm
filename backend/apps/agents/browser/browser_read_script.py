"""READ leg for AUTHED pages: prestage already landed the user's logged-in card on
the target page, so ONE aux call over the live page text can answer a read task and
the big-model loop never starts. The no-browser fast_read can't see behind logins;
this is the same answer-or-INSUFFICIENT contract driven through the real session.
Fail-open everywhere: thin page, decline, error = the loop runs exactly as today.
"""

import asyncio
import logging
import os
import re
import time
from typing import Awaitable, Callable, Dict, Optional

from backend.apps.agents.browser.browser_prestage import RESULTS_URL_RE

logger = logging.getLogger(__name__)

ToolRunner = Callable[[str, Dict, str, str], Awaitable[Dict]]

P_MIN_PAGE_CHARS = 500
# First look: the same modest slice the main loop reads. Most pages answer from this.
FIRST_READ_CHARS = 15000
# Second look, only after a decline: everything we can actually use. Half our live reads used to
# arrive pinned at exactly the smaller cap, with the answer (a reddit thread's comment scores sit
# after the post body) sitting just past the cut, so the aux declined and a 100-220s model loop went
# scrolling for text we had truncated ourselves.
MAX_PAGE_CHARS = 24000
P_TEXT_TIMEOUT_S = 8.0
P_AUX_TIMEOUT_S = 12.0
# Prestage's click often lands here while the SPA is still hydrating (measured: a
# LinkedIn profile read 184 chars right after the click); wait out the render, bounded.
P_THIN_SETTLE_S = 1.2
# Crossing the char floor is NOT the same as being finished rendering: a hydrating SPA clears 500
# chars on nav and footer chrome long before the content lands. Taking that first passing read hands
# the aux a half-drawn page, and it answers confidently from what IS there, so nothing declines and
# the INSUFFICIENT retry below never fires. A confident wrong answer is the one outcome worse than
# just running the loop, so the page has to prove it stopped growing: two reads in a row within this
# much of each other. Costs one extra read plus one short settle on a path that already takes ~7-10s.
P_STABLE_GROWTH = 0.05
P_STABLE_SETTLE_S = 0.4
MAX_READS = 4
# A long-enough-but-still-rendering page reads as INSUFFICIENT (measured: profile
# passed 500 chars with the headline section missing); one settle + re-read + re-ask.
P_INSUFFICIENT_RETRIES = 1
P_INSUFFICIENT_SETTLE_S = 1.5

P_SYSTEM = (
    "Answer the user's request using ONLY the page text provided. Be direct and "
    "complete in a few sentences; quote exact titles/values from the page. End "
    "with nothing else.\n"
    # The old prompt said 'the page text provided' and the model echoed that phrasing straight
    # back, so nearly every answer opened with 'Based on the page text provided...'. The person
    # asked what the price is; they should read the price first, and never read about our plumbing.
    "Lead with the answer itself. Never open with 'Based on', 'I can see', 'The page shows' or "
    "any other preamble, and never mention the page, the text, the browser or how you got the "
    "information: they asked a question, not for a description of your process.\n"
    "Reply with exactly the single word INSUFFICIENT only when the requested "
    "information would live somewhere this page is not (a different page, behind "
    "a click), so the caller should go get it. If THIS page is the right place "
    "and it shows a value (even a placeholder) or visibly lacks the field, that "
    "IS the answer: report exactly what the page shows. A joke, placeholder, or "
    "obviously-fake value is still the answer, quoted, with a note that it looks "
    "like a placeholder; never decline because a shown value looks unreal. Never "
    "guess at anything the page doesn't show."
)


def read_script_enabled() -> bool:
    return os.environ.get("OSW_READ_SCRIPT", "1") != "0"


# A decline written as prose instead of the token. The aux is asked to say INSUFFICIENT when the
# answer lives behind a click, and it usually does, but on a page that is ALMOST right it explains
# itself instead: "I can see the search results, but I cannot access the individual product page."
# That reply used to be accepted as the answer, which ended the run at the wrong page and made a
# perfectly good multi-step task fail 3 times out of 3 on amazon, deterministically. It is a decline,
# so it has to be read as one. Anchored on the aux declaring it cannot REACH somewhere, never on a
# page merely lacking a field, because "the page does not show a price" IS a legitimate answer here.
P_PROSE_DECLINE_RE = re.compile(
    r"\b(?:cannot|can'?t|unable to|don'?t have (?:the )?ability to)\s+"
    r"(?:\w+\s+){0,3}?(?:access|open|reach|navigate(?:\s+to)?|visit|click(?:\s+(?:on|into))?|load)\b"
    r"|\b(?:would|will|you)\s+need\s+to\s+(?:\w+\s+){0,2}?"
    r"(?:open|click|visit|navigate|go\s+to)\b",
    re.I)


# A task that names a ROUTE, not a page. The read script stages ONE page and asks one aux call over
# its text, so a "go to A, then click through to B, then to C" task is answerable from page 1 only by
# guessing. Measured live 2026-08-30 on the packaged candidate: a 4-hop Wikipedia task ran the child
# with turns=1 and llm=0ms (the loop never started) and came back reporting INSUFFICIENT for page 2,
# which is ENG-355's shape arriving through the child instead of the orchestrator.
#
# Declining here costs a slower full loop; accepting costs a partial answer dressed as a complete one,
# so this fails toward the loop on purpose. It needs a SEQUENCE, never a bare navigation verb, because
# "go to X and read the heading" is exactly what this path is for.
P_MULTI_HOP_RE = re.compile(
    r"\bclick(?:ing)?\s+(?:through|into)\b"
    r"|\bfrom\s+(?:there|that\s+page)\b"
    r"|\bone\s+at\s+a\s+time\b"
    r"|\beach\s+of\s+(?:the(?:se|m)?|those)\b"
    r"|\b(?:then|next|after\s+that)\b[^.]{0,60}?\b(?:click|navigate|go\s+to|open|visit|follow)\b"
    r"|\b(?:click|navigate|go\s+to|open|visit|follow)\b[^.]{0,60}?\b(?:then|next|after\s+that)\b",
    re.I,
)


def needs_multi_page(task: str) -> bool:
    """True when the task describes a ROUTE across pages, which one staged read cannot answer."""
    t = task or ""
    if len(set(re.findall(r'https?://[^\s<>"\')\]]+', t))) >= 2:
        return True
    return bool(P_MULTI_HOP_RE.search(t))


def is_answer(reply: str) -> Optional[str]:
    """The usable answer text, or None. Declines, empties, and hedge-shaped replies
    all fail closed to the loop, so a thin extraction can never become a wrong answer."""
    answer = (reply or "").strip()
    if not answer or answer.upper().startswith("INSUFFICIENT"):
        return None
    if P_PROSE_DECLINE_RE.search(answer):
        return None
    return answer


async def run_read_script(
    aux_client, aux_model, task: str, browser_id: str, tab_id: str,
    execute_tool: ToolRunner, current_url: str = "",
) -> Optional[str]:
    """The answer to a read task from the staged page, or None (= run the loop).
    Never raises; never acts on the page beyond reading it."""
    t0 = time.monotonic()
    if aux_client is None or not aux_model:
        return None
    # Bail BEFORE the aux call: a route task cannot be answered from one staged page, and paying for
    # the call only buys a confident-sounding partial.
    if needs_multi_page(task):
        logger.info("[browser-read-script] task spans several pages; running the loop instead")
        return None
    try:
        from backend.apps.agents.core.aux_llm import safe_resp_text

        async def p_page_text(cap: int) -> tuple:
            """Page text, but only once two consecutive reads agree it has stopped growing."""
            prev = -1
            text, url = "", ""
            for attempt in range(MAX_READS):
                r = await asyncio.wait_for(
                    execute_tool("BrowserGetText", {"max_chars": cap}, browser_id, tab_id),
                    timeout=P_TEXT_TIMEOUT_S)
                text = str(r.get("text") or "") if isinstance(r, dict) and "error" not in r else ""
                url = str(r.get("url") or "") if isinstance(r, dict) else ""
                if len(text) >= P_MIN_PAGE_CHARS and 0 <= prev <= len(text) <= prev * (1 + P_STABLE_GROWTH):
                    return text, url
                # Still thin waits longer than merely still-growing: one is a page that has not
                # started, the other is one about to finish.
                thin = len(text) < P_MIN_PAGE_CHARS
                prev = len(text)
                await asyncio.sleep(P_THIN_SETTLE_S if thin else P_STABLE_SETTLE_S)
            return (text, url) if len(text) >= P_MIN_PAGE_CHARS else ("", "")

        for ask in range(1 + P_INSUFFICIENT_RETRIES):
            # Cheap read first, full read only if that one came up short. A search-results page is one
            # we ALWAYS leave (the answer is a click deeper), so buying the whole thing up front is
            # text we can never answer from. Note the wall-clock case for this is NOT proven: live
            # sweeps of these tasks vary 5-12x run to run, which buries an effect this size. It stands
            # on the shape alone, never pay for what you don't need, and the retry is where the big
            # read earns its keep, on a page that IS the right page but got cut off.
            page, p_live_url = await p_page_text(FIRST_READ_CHARS if ask == 0 else MAX_PAGE_CHARS)
            if len(page) < P_MIN_PAGE_CHARS:
                logger.info(f"[browser-readscript] page too thin ({len(page)} chars); loop runs")
                return None
            # On a results LIST the miss is structural (the answer lives one click deeper), not hydration; the settle-retry would just re-decline ~3s later. Judged on the LIVE url: the caller's is stale once plan-dispatch has clicked through (that staleness suppressed the retry on the exact page that needed it, measured).
            p_retries = 0 if RESULTS_URL_RE.search(p_live_url or current_url or "") else P_INSUFFICIENT_RETRIES
            reply = safe_resp_text(await asyncio.wait_for(
                aux_client.messages.create(
                    model=aux_model, max_tokens=500, temperature=0, system=P_SYSTEM,
                    messages=[{"role": "user", "content": (
                        f"Request: {task[:1200]}\n\nPage text:\n{page[:MAX_PAGE_CHARS]}")}],
                ), timeout=P_AUX_TIMEOUT_S))
            ms = int((time.monotonic() - t0) * 1000)
            answer = is_answer(reply)
            if answer is not None:
                logger.info(f"[browser-readscript] answered from the staged page in {ms}ms (ask {ask + 1})")
                return answer
            if ask < p_retries:
                await asyncio.sleep(P_INSUFFICIENT_SETTLE_S)
        logger.info(f"[browser-readscript] insufficient in {int((time.monotonic() - t0) * 1000)}ms; loop runs "
                    f"(page={len(page)}ch url={p_live_url[:80]!r} reply: {(reply or '')[:160]!r})")
        return None
    except Exception as e:
        logger.info(f"[browser-readscript] skipped ({e})")
        return None
