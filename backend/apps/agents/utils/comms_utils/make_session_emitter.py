from typeguard import typechecked
from backend.core.events.events import AnyEvent, ApprovalRequestEvent, EventCallback
from backend.apps.agents.utils.comms_utils.singeltons.singeltons import APPROVAL_BRIDGE, FRONTEND_BROADCASTER

@typechecked
def make_session_emitter(session_id: str) -> EventCallback:
    """Create an event callback that routes typed events to the WS connection pool.

    ApprovalRequestEvents are special-cased: instead of just broadcasting,
    the emitter routes through the APPROVAL_BRIDGE and resolves the
    embedded future with the user's decision.
    """
    async def emit(event: AnyEvent) -> None:
        if isinstance(event, ApprovalRequestEvent):
            if not FRONTEND_BROADCASTER.has_connections():
                if not event.future.done():
                    event.future.set_result({"behavior": "deny", "message": "No dashboard connected for approval."})
                return
            result = await APPROVAL_BRIDGE.request(
                request_id=event.request_id,
                send_fn=lambda: FRONTEND_BROADCASTER.send_to_session(session_id, event.event, {
                    "request_id": event.request_id,
                    "session_id": event.session_id,
                    "tool_name": event.tool_name,
                    "tool_input": event.tool_input,
                }),
                timeout=600.0,
            )
            if not event.future.done():
                event.future.set_result(result)
            return
        await FRONTEND_BROADCASTER.send_to_session(session_id, event.event, event.model_dump(mode="json"))
    return emit