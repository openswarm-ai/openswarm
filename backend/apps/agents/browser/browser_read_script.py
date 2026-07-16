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

logger = logging.getLogger(__name__)

ToolRunner = Callable[[str, Dict, str, str], Awaitable[Dict]]

P_MIN_PAGE_CHARS = 500
P_MAX_PAGE_CHARS = 24000
P_TEXT_TIMEOUT_S = 8.0
P_AUX_TIMEOUT_S = 12.0

P_SYSTEM = (
    "Answer the user's request using ONLY the page text provided. Be direct and "
    "complete in a few sentences; quote exact titles/values from the page. End "
    "with nothing else.\n"
    "If the page text does not contain what the request needs, reply with "
    "exactly the single word INSUFFICIENT."
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
    execute_tool: ToolRunner,
) -> Optional[str]:
    """The answer to a read task from the staged page, or None (= run the loop).
    Never raises; never acts on the page beyond reading it."""
    t0 = time.monotonic()
    if aux_client is None or not aux_model:
        return None
    try:
        r = await asyncio.wait_for(
            execute_tool("BrowserGetText", {}, browser_id, tab_id), timeout=P_TEXT_TIMEOUT_S)
        page = str(r.get("text") or "") if isinstance(r, dict) and "error" not in r else ""
        if len(page) < P_MIN_PAGE_CHARS:
            logger.info(f"[browser-readscript] page too thin ({len(page)} chars); loop runs")
            return None
        from backend.apps.agents.core.aux_llm import safe_resp_text
        reply = safe_resp_text(await asyncio.wait_for(
            aux_client.messages.create(
                model=aux_model, max_tokens=500, temperature=0, system=P_SYSTEM,
                messages=[{"role": "user", "content": (
                    f"Request: {task[:1200]}\n\nPage text:\n{page[:P_MAX_PAGE_CHARS]}")}],
            ), timeout=P_AUX_TIMEOUT_S))
        ms = int((time.monotonic() - t0) * 1000)
        answer = is_answer(reply)
        if answer is None:
            logger.info(f"[browser-readscript] insufficient in {ms}ms; loop runs")
            return None
        logger.info(f"[browser-readscript] answered from the staged page in {ms}ms")
        return answer
    except Exception as e:
        logger.info(f"[browser-readscript] skipped ({e})")
        return None
