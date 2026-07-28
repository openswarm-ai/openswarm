"""The event engine's clock: walks every enabled event trigger, polls its
adapter on that source's own cadence, and feeds resulting events to the
dispatcher. One adaptive-sleep loop (same shape as the workflow scheduler's),
with per-trigger in-flight guards so a slow adapter can't double-poll itself
or stall its neighbors."""

import asyncio
import logging
import time
from typing import Awaitable, Callable, Dict, List, Optional, Set, Tuple

from backend.apps.events import dispatcher, stores
from backend.apps.events.adapters.agent_check import agent_check
from backend.apps.events.adapters.file_watch import file_watch
from backend.apps.events.adapters.web_watch import web_watch
from backend.apps.events.models import CustomEventSource, Event, EventLogEntry, EventTriggerConfig
from backend.apps.workflows.models import Workflow

logger = logging.getLogger(__name__)

# "custom" is deliberately absent: those triggers are push-only via /api/events/ingest.
ADAPTERS: Dict[str, Callable[..., Awaitable[Tuple[List[Event], Dict]]]] = {
    "file": file_watch,
    "web": web_watch,
    "agent": agent_check,
}

p_loop_task: Optional["asyncio.Task"] = None
p_wake = asyncio.Event()
p_next_poll: Dict[str, float] = {}
p_inflight: Set[str] = set()


def kick() -> None:
    p_wake.set()


def mark_due(trigger_id: str) -> None:
    """Schedule this trigger's next poll immediately (used with kick())."""
    p_next_poll[trigger_id] = 0.0


def reset_state() -> None:
    """Test seam: forget all per-trigger poll bookkeeping."""
    global p_loop_task
    p_loop_task = None
    p_next_poll.clear()
    p_inflight.clear()


def p_live_triggers() -> List[Tuple[Workflow, EventTriggerConfig, float]]:
    """(workflow, trigger, poll_seconds) for every pollable trigger; push-only sources are excluded here."""
    from backend.apps.workflows import storage

    out: List[Tuple[Workflow, EventTriggerConfig, float]] = []
    for wf in storage.list_workflows():
        for trig in wf.event_triggers:
            source = trig.source
            if not trig.enabled or isinstance(source, CustomEventSource) or source.kind not in ADAPTERS:
                continue
            out.append((wf, trig, float(source.poll_seconds)))
    return out


async def p_poll_one(workflow_id: str, trigger: EventTriggerConfig) -> None:
    try:
        fetch = ADAPTERS[trigger.source.kind]
        cursor = stores.load_cursor(trigger.id)
        events, new_cursor = await fetch(trigger.source, cursor)
        stores.save_cursor(trigger.id, new_cursor)
        if events:
            await dispatcher.ingest(workflow_id, trigger, events)
    except Exception as e:
        logger.warning("poll failed for trigger %s (%s): %s", trigger.id, trigger.source.kind, e)
        try:
            stores.append_log(workflow_id, EventLogEntry(
                trigger_id=trigger.id, kind="error",
                summary=f"Poll failed: {str(e)[:200]}",
            ))
        except Exception:
            pass
    finally:
        p_inflight.discard(trigger.id)


def tick() -> None:
    from backend.apps.workflows import storage

    # The global "pause all" switch holds event polling too; the cursor diff catches net changes at resume.
    if storage.get_paused():
        return
    now = time.monotonic()
    for wf, trig, poll_seconds in p_live_triggers():
        if p_next_poll.get(trig.id, 0.0) <= now and trig.id not in p_inflight:
            p_next_poll[trig.id] = now + poll_seconds
            p_inflight.add(trig.id)
            asyncio.create_task(p_poll_one(wf.id, trig))


def p_seconds_until_next() -> float:
    now = time.monotonic()
    soonest: Optional[float] = None
    for _, trig, _ in p_live_triggers():
        nxt = p_next_poll.get(trig.id, now)
        if soonest is None or nxt < soonest:
            soonest = nxt
    if soonest is None:
        return 30.0
    return max(1.0, min(soonest - now, 30.0))


async def p_loop() -> None:
    logger.info("event engine poll loop started")
    while True:
        try:
            tick()
        except Exception:
            logger.exception("event poll tick error")
        try:
            await asyncio.wait_for(p_wake.wait(), timeout=p_seconds_until_next())
        except asyncio.TimeoutError:
            pass
        p_wake.clear()


async def start_event_engine() -> None:
    global p_loop_task, p_wake
    from backend.apps.workflows import storage

    if p_loop_task is not None and not p_loop_task.done():
        return
    p_wake = asyncio.Event()
    all_workflows = storage.list_workflows() + storage.list_deleted_workflows()
    all_trigger_ids = [t.id for wf in all_workflows for t in wf.event_triggers]
    try:
        stores.sweep_stale_state(all_trigger_ids, [wf.id for wf in all_workflows])
    except Exception:
        logger.debug("event state sweep failed", exc_info=True)
    # Events buffered at last quit resume their coalesce window now.
    for wf in storage.list_workflows():
        for trig in wf.event_triggers:
            if trig.enabled:
                restored = dispatcher.restore_pending(wf.id, trig)
                if restored:
                    logger.info("restored %d pending event(s) for trigger %s", restored, trig.id)
    p_loop_task = asyncio.create_task(p_loop())


async def stop_event_engine() -> None:
    global p_loop_task
    # Cancel the loop before the dispatcher so a mid-cancel tick can't schedule fresh flushes.
    if p_loop_task is not None:
        p_loop_task.cancel()
        try:
            await p_loop_task
        except (asyncio.CancelledError, Exception):
            pass
        p_loop_task = None
    dispatcher.stop()
    reset_state()
