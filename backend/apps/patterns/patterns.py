"""Routes + lifecycle for pattern suggestions. The miner runs shortly after
boot and then daily; accepting a suggestion creates a REAL workflow through
the same create path the Workflows UI uses, so the user reviews and owns it
like any other."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import HTTPException

from backend.apps.patterns import store
from backend.apps.patterns.miner import run_mining_pass
from backend.apps.patterns.models import WorkflowSuggestion
from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)

BOOT_DELAY_SECONDS = 45.0
CHECK_INTERVAL_SECONDS = 6 * 3600.0

p_loop_task: Optional["asyncio.Task"] = None


async def p_mining_loop() -> None:
    await asyncio.sleep(BOOT_DELAY_SECONDS)
    while True:
        try:
            added = await run_mining_pass()
            if added:
                logger.info("[pattern-miner] added %d suggestion(s)", added)
        except Exception:
            logger.exception("pattern mining loop error")
        await asyncio.sleep(CHECK_INTERVAL_SECONDS)


@asynccontextmanager
async def patterns_lifespan():
    global p_loop_task
    p_loop_task = asyncio.create_task(p_mining_loop())
    try:
        yield
    finally:
        if p_loop_task is not None:
            p_loop_task.cancel()
            try:
                await p_loop_task
            except (asyncio.CancelledError, Exception):
                pass
            p_loop_task = None


patterns = SubApp("patterns", patterns_lifespan)


@patterns.router.get("/suggestions")
async def list_suggestions():
    return {"suggestions": [s.model_dump(mode="json") for s in store.pending_suggestions()]}


def p_get_pending_or_404(suggestion_id: str) -> WorkflowSuggestion:
    suggestion = store.get_suggestion(suggestion_id)
    if suggestion is None:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    if suggestion.status != "pending":
        raise HTTPException(status_code=409, detail=f"Suggestion already {suggestion.status}")
    return suggestion


@patterns.router.post("/suggestions/{suggestion_id}/accept")
async def accept_suggestion(suggestion_id: str):
    from backend.apps.workflows.models import ScheduleConfig, WorkflowCreate, WorkflowStep
    from backend.apps.workflows.workflows import create_workflow

    suggestion = p_get_pending_or_404(suggestion_id)
    if suggestion.cadence.kind == "weekly":
        schedule = ScheduleConfig(enabled=True, repeat_unit="week", repeat_every=1, on_days=suggestion.cadence.on_days, hour=suggestion.cadence.hour, minute=0)
    elif suggestion.cadence.kind == "daily":
        schedule = ScheduleConfig(enabled=True, repeat_unit="day", repeat_every=1, hour=suggestion.cadence.hour, minute=0)
    else:
        # No clear rhythm in the evidence: create it ready to run, let the user schedule or add a trigger.
        schedule = ScheduleConfig(enabled=False)
    steps = [WorkflowStep(text=t) for t in suggestion.workflow_steps]
    body = WorkflowCreate(
        title=suggestion.workflow_title or "Suggested workflow",
        description=suggestion.description,
        steps=steps,
        schedule=schedule,
        auto_named=False,
        # The explicit accept IS the validation moment; byte-matches the FE stepsSignature so the test-first nag never fires.
        tested_signature=json.dumps([[s.id, s.text] for s in steps], separators=(",", ":"), ensure_ascii=False),
    )
    workflow = await create_workflow(body)
    suggestion.status = "accepted"
    suggestion.workflow_id = str(workflow.get("id") or "") or None
    store.update_suggestion(suggestion)
    return {"suggestion": suggestion.model_dump(mode="json"), "workflow": workflow}


@patterns.router.post("/suggestions/{suggestion_id}/dismiss")
async def dismiss_suggestion(suggestion_id: str):
    suggestion = p_get_pending_or_404(suggestion_id)
    suggestion.status = "dismissed"
    store.update_suggestion(suggestion)
    return {"ok": True}


@patterns.router.post("/mine")
async def mine_now():
    """Force a mining pass (ignores the daily throttle; the settings kill switch still applies)."""
    added = await run_mining_pass(force=True)
    return {"added": added, "pending": len(store.pending_suggestions())}
