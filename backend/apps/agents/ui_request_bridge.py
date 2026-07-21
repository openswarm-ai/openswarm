"""Blocking bridge for interactive tool-ui components: AskUI parks here until the user
answers in the transcript (or the wait times out). Keyed by (session_id, component props.id),
so the frontend can respond without ever learning a server-side request id."""

import asyncio
from typing import Any, Dict, Optional, Tuple

from pydantic import BaseModel, ConfigDict, InstanceOf
from typeguard import typechecked

MAX_PENDING = 50
MAX_WAIT_SECONDS = 600.0


class PendingUiRequest(BaseModel):
    model_config = ConfigDict(validate_assignment=True)
    event: InstanceOf[asyncio.Event]
    response: Optional[Dict[str, Any]] = None


p_pending: Dict[Tuple[str, str], PendingUiRequest] = {}


@typechecked
async def wait_for_ui_response(session_id: str, component_id: str, timeout_s: float) -> Optional[Dict[str, Any]]:
    """Registers the request and blocks until respond_to_ui_request fires it; None on timeout."""
    if len(p_pending) >= MAX_PENDING:
        raise ValueError("too many pending UI requests")
    key = (session_id, component_id)
    # A retried tool call for the same component replaces the stale wait; the old waiter times out.
    pending = PendingUiRequest(event=asyncio.Event())
    p_pending[key] = pending
    try:
        await asyncio.wait_for(pending.event.wait(), timeout=min(timeout_s, MAX_WAIT_SECONDS))
        return pending.response
    except asyncio.TimeoutError:
        return None
    finally:
        if p_pending.get(key) is pending:
            p_pending.pop(key, None)


@typechecked
def respond_to_ui_request(session_id: str, component_id: str, response: Dict[str, Any]) -> bool:
    """Delivers the user's answer to the parked wait; False when nothing is waiting."""
    pending = p_pending.get((session_id, component_id))
    if pending is None:
        return False
    pending.response = response
    pending.event.set()
    return True


@typechecked
def has_pending_ui_request(session_id: str, component_id: str) -> bool:
    return (session_id, component_id) in p_pending
