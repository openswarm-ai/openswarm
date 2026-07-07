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
import re
import time
from typing import Awaitable, Callable

logger = logging.getLogger(__name__)

P_QUOTED_RE = re.compile(r"['\"]([^'\"]{4,300})['\"]")
P_COMPOSER_ROW_RE = re.compile(r"\[(\d+)\]\*?<\s*textbox\s+\"([^\"]*)\"", re.I)
P_COMPOSER_NAME_RE = re.compile(r"write|message|compose|reply", re.I)

ToolRunner = Callable[[str, dict, str, str], Awaitable[dict]]


def script_enabled() -> bool:
    return os.environ.get("OSW_SEND_SCRIPT", "0") != "0"


def quoted_payload(task: str) -> str:
    """The exact text the user quoted, only when it's unambiguous: exactly one
    distinct quoted span in the task. Anything else is the model's judgment call."""
    spans = {m.group(1).strip() for m in P_QUOTED_RE.finditer(task or "") if m.group(1).strip()}
    return spans.pop() if len(spans) == 1 else ""


def composer_index_in_state(state_text: str):
    """(index, name) of the single compose-shaped textbox, or None. Two
    candidates = ambiguous = model's problem."""
    hits = [(int(m.group(1)), m.group(2)) for m in P_COMPOSER_ROW_RE.finditer(state_text or "")
            if P_COMPOSER_NAME_RE.search(m.group(2) or "")]
    return hits[0] if len(hits) == 1 else None


async def run_send_script(
    task: str,
    browser_id: str,
    tab_id: str,
    state_text: str,
    execute_tool: ToolRunner,
    send_index_in_state,
    payload_in_textbox,
) -> dict | None:
    """None = stage not script-ready or aborted pre-click (model path, stage
    untouched except a possibly committed fill, which the model sees). A dict
    means the irreversible click RAN: {'sent': bool_receipt_verified,
    'payload': str, 'log': [...], 'note': str}."""
    t0 = time.monotonic()
    payload = quoted_payload(task)
    composer = composer_index_in_state(state_text)
    send_btn = send_index_in_state(state_text)
    if not (payload and composer and send_btn):
        return None
    log: list[dict] = []

    async def fresh_list() -> str:
        try:
            r = await asyncio.wait_for(
                execute_tool("BrowserListInteractives", {}, browser_id, tab_id), timeout=6.0)
            return str(r.get("text") or "") if isinstance(r, dict) and "error" not in r else ""
        except Exception:
            return ""

    # 1. fill (focused by node, the composer overlay path coordinate clicks miss)
    r_fill = await execute_tool("BrowserClickIndex", {"index": composer[0], "text": payload}, browser_id, tab_id)
    fill_ok = isinstance(r_fill, dict) and "error" not in r_fill
    log.append({"tool": "BrowserClickIndex", "input": {"index": composer[0], "text": payload},
                "ok": fill_ok, "result_summary": f"script fill into {composer[1]!r}"[:200], "elapsed_ms": 0})
    if not fill_ok:
        logger.info("[browser-sendscript] fill errored; handing to model untouched")
        return None
    # 2. verify committed + re-resolve Send from the same fresh state
    state2 = ""
    for wait_s in (0.4, 1.0):
        await asyncio.sleep(wait_s)
        state2 = await fresh_list()
        if state2 and payload_in_textbox(state2, payload):
            break
    if not (state2 and payload_in_textbox(state2, payload)):
        logger.info("[browser-sendscript] fill not seen committed; aborting pre-click")
        return None
    send_btn2 = send_index_in_state(state2)
    if not send_btn2:
        logger.info("[browser-sendscript] Send button gone from fresh state; aborting pre-click")
        return None
    # 3. the one irreversible click, solo
    r_send = await execute_tool("BrowserClickIndex", {"index": send_btn2[0]}, browser_id, tab_id)
    send_ok = isinstance(r_send, dict) and "error" not in r_send
    log.append({"tool": "BrowserClickIndex", "input": {"index": send_btn2[0]},
                "ok": send_ok, "result_summary": f"script send click {send_btn2[1]!r}"[:200],
                "elapsed_ms": 0, "clicked_role": "button", "clicked_name": send_btn2[1]})
    if not send_ok:
        logger.info("[browser-sendscript] send click errored; handing to model (fill committed, NOT sent)")
        return None
    # 4. two-sided receipt: composer seen cleared of the payload
    cleared = False
    for wait_s in (0.4, 1.0, 1.6):
        await asyncio.sleep(wait_s)
        state3 = await fresh_list()
        if state3 and not payload_in_textbox(state3, payload):
            cleared = True
            break
    note = ("" if cleared else
            "A Send-class click already RAN for this payload but the composer state is unverified: "
            "verify on the page whether it delivered; do NOT send again unless verifiably absent.")
    logger.info(f"[browser-sendscript] done sent_receipt={cleared} in {int((time.monotonic() - t0) * 1000)}ms")
    return {"sent": cleared, "payload": payload, "log": log, "note": note}
