"""One verified action, the executor's unit of work: resolve the target LATE against
the live page, act, verify the SPECIFIC expected effect, and re-aim on a miss, all in
code, no LLM turn. This generalizes the send-script's proven fill->verify->send->verify
from one LinkedIn flow to any site: the target is a semantic name, the effect is a
generic expectation, and neither knows about any particular page.

The one safety invariant, same bar as the send-script: an IRREVERSIBLE step (send /
submit / pay) is NEVER re-fired. If it acted but the effect can't be verified, it
returns an honest "acted, unverified, do NOT repeat" note instead of retrying, so a
receipt we couldn't read can never become a double-send.
"""

import asyncio
import logging
from typing import Awaitable, Callable, Optional, Tuple

from pydantic import BaseModel, ConfigDict

from backend.apps.agents.browser import browser_verified_action as va

logger = logging.getLogger(__name__)

ToolRunner = Callable[[str, dict, str, str], Awaitable[dict]]


class VerifiedStep(BaseModel):
    model_config = ConfigDict(validate_assignment=True)
    kind: str            # "click" | "fill"
    target: str          # semantic element name to resolve against the live list
    role: str = ""       # optional role hint ("button", "link", "textbox") to disambiguate
    text: str = ""       # for a fill
    expect: str = ""     # generic expectation; defaults to filled:<text> / changed
    irreversible: bool = False  # send/submit/pay: acted-but-unverified NEVER re-fires


async def p_fresh(execute_tool: ToolRunner, browser_id: str, tab_id: str) -> Tuple[str, str]:
    try:
        r = await asyncio.wait_for(
            execute_tool("BrowserListInteractives", {}, browser_id, tab_id), timeout=6.0)
    except Exception:
        return "", ""
    if not isinstance(r, dict) or "error" in r:
        return "", ""
    return str(r.get("text") or ""), str(r.get("url") or "")


async def p_act(step: VerifiedStep, index: Optional[int],
                browser_id: str, tab_id: str, execute_tool: ToolRunner) -> dict:
    if step.kind == "fill":
        return await execute_tool(
            "BrowserClickIndex", {"index": index, "text": step.text}, browser_id, tab_id)
    if index is not None:
        return await execute_tool("BrowserClickIndex", {"index": index}, browser_id, tab_id)
    # a click whose index didn't resolve falls to by-name (full-DOM search, past the list cap)
    return await execute_tool(
        "BrowserClickByName", {"name": step.target, "role": step.role}, browser_id, tab_id)


def p_default_expect(step: VerifiedStep) -> str:
    if step.expect:
        return step.expect
    return f"filled:{step.text}" if step.kind == "fill" else "changed"


async def run_verified_step(
    step: VerifiedStep, browser_id: str, tab_id: str, execute_tool: ToolRunner,
    settle_s: float = 0.8, max_reaim: int = 1,
) -> dict:
    """{ok, verified, acted, note}. ok == the expected effect was observed. A reversible
    step that doesn't verify is re-aimed (re-resolve + re-act) up to max_reaim times; an
    irreversible one is never re-fired once it has acted."""
    expect = p_default_expect(step)
    note = ""
    for attempt in range(max_reaim + 1):
        before, before_url = await p_fresh(execute_tool, browser_id, tab_id)
        tgt = va.resolve_target(before, step.target, step.role)
        index = tgt[0] if tgt else None
        if step.kind == "fill" and index is None:
            return {"ok": False, "verified": False, "acted": False,
                    "note": f"could not resolve a field named {step.target!r} to fill"}
        r = await p_act(step, index, browser_id, tab_id, execute_tool)
        acted = isinstance(r, dict) and "error" not in r
        if not acted:
            note = f"action errored: {r.get('error') if isinstance(r, dict) else r}"
            if step.irreversible:
                # an errored irreversible action provably did NOT happen; safe to stop, never retry blindly
                return {"ok": False, "verified": False, "acted": False, "note": note}
            continue  # reversible: re-aim
        await asyncio.sleep(settle_s)
        after, after_url = await p_fresh(execute_tool, browser_id, tab_id)
        if va.expectation_met(expect, before, after, before_url, after_url):
            logger.info(f"[verified-step] {step.kind} {step.target!r} -> {expect} OK (attempt {attempt + 1})")
            return {"ok": True, "verified": True, "acted": True, "note": ""}
        if step.irreversible:
            # acted, effect unverifiable: the send-script's honesty rule, never a blind repeat
            return {"ok": False, "verified": False, "acted": True,
                    "note": (f"an irreversible {step.target!r} action already RAN but its effect is "
                             "unverified; verify on the page, do NOT repeat it unless verifiably absent")}
        note = f"expected {expect!r} not observed after {step.kind} {step.target!r}"
    logger.info(f"[verified-step] {step.kind} {step.target!r} unverified: {note}")
    return {"ok": False, "verified": False, "acted": True, "note": note}
