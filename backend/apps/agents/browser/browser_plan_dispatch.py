"""Code-side plan dispatch: the turn-collapser that does NOT depend on the model
adopting a tool (it never does; 0/3 live A/Bs). ONE cheap aux call maps the task +
live page state to a chain of verified steps; run_verified_step executes them in
code (resolve-late, verify-effect, re-aim); the big model then starts with the
mechanical work DONE instead of spending a ~4-6s turn per click.

Safety mirrors the send-script: the aux may only emit click/fill on elements it
names from the live list, anything irreversible-smelling is refused in code, and
every step must VERIFY or the chain stops and hands off honestly. Fail-open
everywhere: no aux, bad JSON, zero steps = the loop runs exactly as today.
"""

import asyncio
import json
import logging
import os
import re
import time

from backend.apps.agents.browser import browser_verified_step
from backend.apps.agents.browser.browser_prestage import P_BLOCKED_CLICK_RE

logger = logging.getLogger(__name__)

P_MAX_STEPS = 4
P_AUX_TIMEOUT_S = 10.0

P_SYSTEM = (
    "You compile the MECHANICAL prefix of a browser task into steps a dumb executor "
    "runs. You see the task and the page's interactive elements. Emit ONLY steps you "
    "are confident about, in order, as STRICT JSON (no prose): an array of\n"
    '{"action":"click"|"fill","target":"<element name EXACTLY as listed>",'
    '"role":"button"|"link"|"textbox"|"","text":"<for fill>",'
    '"expect":"appeared:<text>"|"gone:<text>"|"url_changed"|"changed"|""}\n'
    "Rules: target must be copied verbatim from a listed element name. ORDINALS map "
    "to rows: 'the 4th story's comments' = copy the name of the 4th row matching that "
    "shape (e.g. the 4th 'N comments' link, counting from the top of the list); you "
    "may and should count. STOP before anything irreversible (send/submit/post/pay/"
    "delete/confirm/apply), before any ambiguous choice, and before steps whose "
    "elements are not yet on the page. 0-4 steps; [] when nothing is safely mechanical."
)


def parse_plan(reply: str) -> list:
    """Strict-ish JSON array extraction; anything malformed = [] (fail-open)."""
    m = re.search(r"\[.*\]", (reply or "").strip(), re.S)
    if not m:
        return []
    try:
        raw = json.loads(m.group(0))
    except Exception:
        return []
    steps = []
    for r in raw[:P_MAX_STEPS]:
        if not isinstance(r, dict):
            continue
        action = str(r.get("action") or "")
        target = str(r.get("target") or "").strip()
        if action not in ("click", "fill") or not target:
            continue
        if P_BLOCKED_CLICK_RE.search(target):
            break  # irreversible-smelling: refuse this and everything after it
        steps.append(browser_verified_step.VerifiedStep(
            kind=action, target=target, role=str(r.get("role") or ""),
            text=str(r.get("text") or ""), expect=str(r.get("expect") or "")))
    return steps


def plan_dispatch_enabled() -> bool:
    return os.environ.get("OSW_PLAN_DISPATCH", "0") == "1"


async def run_plan_dispatch(
    task: str, state_text: str, browser_id: str, tab_id: str,
    settings, primary_api, execute_tool,
) -> str:
    """Returns a handoff note describing verified-executed steps ('' = nothing ran).
    Never raises; never acts irreversibly."""
    t0 = time.monotonic()
    try:
        from backend.apps.settings.credentials import get_anthropic_client_for_model
        from backend.apps.agents.providers.registry import resolve_aux_model
        from backend.apps.agents.core.aux_llm import safe_resp_text

        aux_model, _ = await resolve_aux_model(settings, preferred_tier="haiku", primary_api=primary_api)
        client = get_anthropic_client_for_model(settings, aux_model)
        reply = safe_resp_text(await asyncio.wait_for(
            client.messages.create(
                model=aux_model, max_tokens=400, temperature=0, system=P_SYSTEM,
                messages=[{"role": "user", "content": (
                    f"Task: {task[:1200]}\n\nInteractive elements:\n{state_text[:3500]}")}],
            ), timeout=P_AUX_TIMEOUT_S))
        steps = parse_plan(reply)
        if not steps:
            logger.info("[plan-dispatch] aux emitted no safe mechanical steps")
            return ""
        done: list[str] = []
        for step in steps:
            r = await browser_verified_step.run_verified_step(
                step, browser_id, tab_id, execute_tool)
            if not r["ok"]:
                done.append(f"{step.kind} {step.target!r} FAILED ({r['note']}); stopped there")
                break
            done.append(f"{step.kind} {step.target!r} done+verified")
        note = (
            f"[Plan pre-executed and VERIFIED in code: {'; '.join(done)}. "
            "Do NOT redo these; continue from the page's CURRENT state below.]"
        )
        logger.info(f"[plan-dispatch] {len(done)} step(s) in {int((time.monotonic() - t0) * 1000)}ms: {'; '.join(done)[:160]}")
        return note
    except Exception as e:
        logger.info(f"[plan-dispatch] skipped ({e})")
        return ""
