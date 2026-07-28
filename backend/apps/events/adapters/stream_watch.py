"""The held-open streaming tier: subscribe to a Server-Sent Events feed and
turn its messages into trigger events as they arrive; nothing is transient
because we read the source's own event log, not snapshots. Events batch
(count or interval, whichever first) before hitting the dispatcher so a
firehose can't write pending files per message; the contains-filter drops
noise before it costs anything. Reconnects back off through the same failure
bookkeeping polls use, so a dead feed surfaces instead of spinning."""

import asyncio
import hashlib
import logging
import time
from typing import List, Optional

from backend.apps.events.models import Event, EventTriggerConfig, StreamSource

logger = logging.getLogger(__name__)

BATCH_MAX_EVENTS = 25
BATCH_MAX_SECONDS = 2.0
RECONNECT_MAX_SECONDS = 300.0
DATA_KEEP_CHARS = 2000


def parse_sse_data(line_buffer: List[str]) -> Optional[str]:
    """One SSE event's data payload from its buffered lines; None for keepalives/comments."""
    data_lines = [ln[5:].lstrip() for ln in line_buffer if ln.startswith("data:")]
    joined = "\n".join(data_lines).strip()
    return joined or None


def stream_event_from(data: str, contains: str) -> Optional[Event]:
    if contains.strip() and contains.strip().lower() not in data.lower():
        return None
    digest = hashlib.sha256(data.encode()).hexdigest()[:16]
    return Event(
        source="stream",
        event_type="stream_event",
        summary=data.replace("\n", " ")[:200],
        dedup_key=f"{digest}:{int(time.time())}",
        payload={"data": data[:DATA_KEEP_CHARS]},
    )


async def run_stream_source(workflow_id: str, trigger: EventTriggerConfig, source: StreamSource) -> None:
    """Long-lived task; cancelled by the reconciler when the trigger changes or dies."""
    import httpx

    from backend.apps.events import dispatcher, stores
    from backend.apps.events.models import EventLogEntry

    backoff = 1.0
    while True:
        batch: List[Event] = []
        batch_started = time.monotonic()

        async def flush_batch() -> None:
            nonlocal batch, batch_started
            if batch:
                await dispatcher.ingest(workflow_id, trigger, batch)
                batch = []
            batch_started = time.monotonic()

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=90.0)) as client:
                # Some public feeds (Wikimedia among them) 403 requests with no User-Agent.
                sse_headers = {"Accept": "text/event-stream", "User-Agent": "OpenSwarm-EventTrigger/1.0"}
                async with client.stream("GET", source.url, headers=sse_headers) as resp:
                    resp.raise_for_status()
                    stores.clear_poll_failures(trigger.id)
                    backoff = 1.0
                    logger.info("stream connected for trigger %s: %s", trigger.id, source.url)
                    line_buffer: List[str] = []
                    async for line in resp.aiter_lines():
                        if line:
                            line_buffer.append(line)
                            continue
                        data = parse_sse_data(line_buffer)
                        line_buffer = []
                        if data:
                            event = stream_event_from(data, source.contains)
                            if event:
                                batch.append(event)
                        if batch and (len(batch) >= BATCH_MAX_EVENTS or time.monotonic() - batch_started >= BATCH_MAX_SECONDS):
                            await flush_batch()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            try:
                await flush_batch()
            except Exception:
                pass
            failures = stores.record_poll_failure(trigger.id, str(e)[:200])
            try:
                stores.append_log(workflow_id, EventLogEntry(
                    trigger_id=trigger.id, kind="error",
                    summary=f"Stream dropped: {str(e)[:160]} (failure {failures}; reconnecting in ~{int(backoff)}s)",
                ))
            except Exception:
                pass
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, RECONNECT_MAX_SECONDS)
