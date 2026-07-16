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

P_MAX_STEPS = 6
P_AUX_TIMEOUT_S = 10.0
# Cross-page steps land right after a navigation; give the new page a beat before resolving.
P_STEP_SETTLE_S = 1.2
P_STATE_CAP = 6000

P_SYSTEM = (
    "You compile the MECHANICAL prefix of a browser task into steps a dumb executor "
    "runs and VERIFIES one at a time. You see the task and the page's interactive "
    "elements. Emit ONLY steps in order, as STRICT JSON (no prose): an array of\n"
    '{"action":"click"|"fill","target":"<element name EXACTLY as listed>",'
    '"role":"button"|"link"|"textbox"|"","text":"<for fill>",'
    '"expect":"appeared:<text>"|"gone:<text>"|"url_changed"|"changed"|"",'
    '"chosen":true|false}\n'
    "Rules: a target is copied verbatim from a listed element name, EXCEPT steps after "
    "one that navigates: those may name an element the task implies will appear (e.g. "
    "'Message' after opening a profile). Each step is resolved against the live page "
    "and verified before the next runs, so a wrong guess stops the chain safely. "
    "Expectations: use url_changed for clicks that open a new page, appeared:<text> "
    "for clicks that open a dialog or composer. ORDINALS map to rows: 'the 4th "
    "story's comments' = copy the name of the 4th row matching that shape; you may "
    "and should count. When the task names a person or thing and several rows are "
    "similar, PICK the best row using the task's cues and mark that step "
    "\"chosen\":true; for messaging a person, a direct/1st-degree connection outranks "
    "every other cue (title, company, verified): people message people they know. STOP the chain before "
    "anything irreversible (send/submit/post/pay/delete/confirm/apply). NEVER fill a "
    "message, comment, or post body: once a composer for one is open, stop, the main "
    "agent writes and sends it. 0-6 steps; [] when nothing is safely mechanical."
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
            text=str(r.get("text") or ""), expect=str(r.get("expect") or ""),
            chosen=bool(r.get("chosen"))))
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
                model=aux_model, max_tokens=600, temperature=0, system=P_SYSTEM,
                messages=[{"role": "user", "content": (
                    f"Task: {task[:1200]}\n\nInteractive elements:\n{state_text[:P_STATE_CAP]}")}],
            ), timeout=P_AUX_TIMEOUT_S))
        steps = parse_plan(reply)
        if not steps:
            logger.info(f"[plan-dispatch] aux emitted no safe mechanical steps "
                        f"(state={len(state_text)}ch, reply: {(reply or '')[:160]!r})")
            return ""
        done: list[str] = []
        for step in steps:
            r = await browser_verified_step.run_verified_step(
                step, browser_id, tab_id, execute_tool, settle_s=P_STEP_SETTLE_S)
            if not r["ok"]:
                done.append(f"{step.kind} {step.target!r} FAILED ({r['note']}); stopped there")
                break
            mark = " [CHOSEN among similar rows: confirm it matches the task before anything irreversible]" if step.chosen else ""
            done.append(f"{step.kind} {step.target!r} done+verified{mark}")
        note = (
            f"[Plan pre-executed and VERIFIED in code: {'; '.join(done)}. "
            "Do NOT redo these; continue from the page's CURRENT state below.]"
        )
        logger.info(f"[plan-dispatch] {len(done)} step(s) in {int((time.monotonic() - t0) * 1000)}ms: {'; '.join(done)[:160]}")
        return note
    except Exception as e:
        logger.info(f"[plan-dispatch] skipped ({e})")
        return ""
