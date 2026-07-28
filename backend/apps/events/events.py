"""Routes for the event engine. POST /api/events/ingest is the universal push
entry: any script, webhook forwarder, macOS Shortcut, or MCP can feed a
workflow's custom trigger. Ingested events ride the SAME dispatcher path as
polled ones, so coalescing, the predicate, and the rate cap all still apply.
The engine's lifecycle itself rides workflows_lifespan; this SubApp is
routes-only. Auth: the per-install bearer token gates this like every other
localhost API route."""

from contextlib import asynccontextmanager
from typing import Dict
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, Field

from backend.apps.events import dispatcher, stores
from backend.apps.events.models import Event
from backend.config.Apps import SubApp


@asynccontextmanager
async def events_lifespan():
    yield


events = SubApp("events", events_lifespan)

MAX_SEEN_KEYS = 300


class IngestBody(BaseModel):
    workflow_id: str
    trigger_id: str
    summary: str
    event_type: str = "custom"
    # Same key twice = delivered once; lets webhook retries stay idempotent.
    dedup_key: str = ""
    payload: Dict = Field(default_factory=dict)


@events.router.post("/ingest")
async def ingest_event(body: IngestBody):
    from backend.apps.workflows import storage

    wf = storage.get_workflow(body.workflow_id)
    if wf is None or wf.deleted_at is not None:
        raise HTTPException(status_code=404, detail="Workflow not found")
    trigger = next((t for t in wf.event_triggers if t.id == body.trigger_id), None)
    if trigger is None:
        raise HTTPException(status_code=404, detail="Trigger not found")
    if trigger.source.kind != "custom":
        raise HTTPException(status_code=409, detail="Trigger is not a custom (ingest) source")
    if not trigger.enabled:
        raise HTTPException(status_code=409, detail="Trigger is disabled")
    summary = body.summary.strip()[:300]
    if not summary:
        raise HTTPException(status_code=400, detail="summary is required")
    dedup_key = body.dedup_key.strip() or uuid4().hex
    cursor = stores.load_cursor(trigger.id)
    seen = [str(k) for k in (cursor.get("seen") or [])]
    if dedup_key in seen:
        return {"ok": True, "queued": 0, "deduped": True}
    seen.append(dedup_key)
    stores.save_cursor(trigger.id, {"seen": seen[-MAX_SEEN_KEYS:]})
    await dispatcher.ingest(wf.id, trigger, [Event(
        source="custom",
        event_type=(body.event_type.strip() or "custom")[:60],
        summary=summary,
        dedup_key=dedup_key,
        payload=body.payload,
    )])
    return {"ok": True, "queued": 1, "deduped": False}
