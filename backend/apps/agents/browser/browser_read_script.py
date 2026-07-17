"""READ leg for AUTHED pages: prestage already landed the user's logged-in card on
the target page, so ONE aux call over the live page text can answer a read task and
the big-model loop never starts. The no-browser fast_read can't see behind logins;
this is the same answer-or-INSUFFICIENT contract driven through the real session.
Fail-open everywhere: thin page, decline, error = the loop runs exactly as today.
"""

import asyncio
import logging
import os
import time
from typing import Awaitable, Callable, Dict, Optional

from backend.apps.agents.browser.browser_prestage import RESULTS_URL_RE

logger = logging.getLogger(__name__)

ToolRunner = Callable[[str, Dict, str, str], Awaitable[Dict]]

P_MIN_PAGE_CHARS = 500
P_MAX_PAGE_CHARS = 24000
P_TEXT_TIMEOUT_S = 8.0
P_AUX_TIMEOUT_S = 12.0
# Prestage's click often lands here while the SPA is still hydrating (measured: a
# LinkedIn profile read 184 chars right after the click); wait out the render, bounded.
P_THIN_RETRIES = 3
P_THIN_SETTLE_S = 1.2
# A long-enough-but-still-rendering page reads as INSUFFICIENT (measured: profile
# passed 500 chars with the headline section missing); one settle + re-read + re-ask.
P_INSUFFICIENT_RETRIES = 1
P_INSUFFICIENT_SETTLE_S = 1.5

P_SYSTEM = (
    "Answer the user's request using ONLY the page text provided. Be direct and "
    "complete in a few sentences; quote exact titles/values from the page. End "
    "with nothing else.\n"
    "Reply with exactly the single word INSUFFICIENT only when the requested "
    "information would live somewhere this page is not (a different page, behind "
    "a click), so the caller should go get it. If THIS page is the right place "
    "and it shows a value (even a placeholder) or visibly lacks the field, that "
    "IS the answer: report exactly what the page shows. Never guess at anything "
    "the page doesn't show."
)


def read_script_enabled() -> bool:
    return os.environ.get("OSW_READ_SCRIPT", "0") != "0"


def is_answer(reply: str) -> Optional[str]:
    """The usable answer text, or None. Declines, empties, and hedge-shaped replies
    all fail closed to the loop, so a thin extraction can never become a wrong answer."""
    answer = (reply or "").strip()
    if not answer or answer.upper().startswith("INSUFFICIENT"):
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
    try:
        from backend.apps.agents.core.aux_llm import safe_resp_text

        async def p_page_text() -> tuple:
            for attempt in range(P_THIN_RETRIES):
                r = await asyncio.wait_for(
                    execute_tool("BrowserGetText", {}, browser_id, tab_id), timeout=P_TEXT_TIMEOUT_S)
                text = str(r.get("text") or "") if isinstance(r, dict) and "error" not in r else ""
                url = str(r.get("url") or "") if isinstance(r, dict) else ""
                if len(text) >= P_MIN_PAGE_CHARS:
                    return text, url
                await asyncio.sleep(P_THIN_SETTLE_S)
            return "", ""

        for ask in range(1 + P_INSUFFICIENT_RETRIES):
            page, p_live_url = await p_page_text()
            if len(page) < P_MIN_PAGE_CHARS:
                logger.info(f"[browser-readscript] page too thin ({len(page)} chars); loop runs")
                return None
            # On a results LIST the miss is structural (the answer lives one click deeper), not hydration; the settle-retry would just re-decline ~3s later. Judged on the LIVE url: the caller's is stale once plan-dispatch has clicked through (that staleness suppressed the retry on the exact page that needed it, measured).
            p_retries = 0 if RESULTS_URL_RE.search(p_live_url or current_url or "") else P_INSUFFICIENT_RETRIES
            reply = safe_resp_text(await asyncio.wait_for(
                aux_client.messages.create(
                    model=aux_model, max_tokens=500, temperature=0, system=P_SYSTEM,
                    messages=[{"role": "user", "content": (
                        f"Request: {task[:1200]}\n\nPage text:\n{page[:P_MAX_PAGE_CHARS]}")}],
                ), timeout=P_AUX_TIMEOUT_S))
            ms = int((time.monotonic() - t0) * 1000)
            answer = is_answer(reply)
            if answer is not None:
                logger.info(f"[browser-readscript] answered from the staged page in {ms}ms (ask {ask + 1})")
                return answer
            if ask < p_retries:
                await asyncio.sleep(P_INSUFFICIENT_SETTLE_S)
        logger.info(f"[browser-readscript] insufficient in {int((time.monotonic() - t0) * 1000)}ms; loop runs")
        return None
    except Exception as e:
        logger.info(f"[browser-readscript] skipped ({e})")
        return None
