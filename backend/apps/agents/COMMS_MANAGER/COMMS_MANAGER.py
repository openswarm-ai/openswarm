from typing import Optional, Literal, Dict, Any
from uuid import uuid4
from pydantic import BaseModel, Field
from typeguard import typechecked

from backend.apps.agents.utils.comms_utils.classes.FutureBridge import FutureBridge
from backend.apps.agents.utils.comms_utils.classes.FrontendBroadcaster import FrontendBroadcaster
from backend.core.events.events import AnyEvent, ApprovalRequestEvent, EventCallback


class CommsManager(BaseModel):
    broadcaster: FrontendBroadcaster = Field(default_factory=FrontendBroadcaster)
    approval_bridge: FutureBridge = Field(default_factory=FutureBridge)
    browser_bridge: FutureBridge = Field(default_factory=FutureBridge)

    @typechecked
    async def resolve_approval(
        self,
        request_id: str,
        behavior: Literal["allow", "deny"],
        message: Optional[str] = None,
        updated_input: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.approval_bridge.resolve(request_id, {
            "behavior": behavior,
            "message": message,
            "updated_input": updated_input,
        })

    @typechecked
    def make_session_emitter(self, session_id: str) -> EventCallback:
        """Create an event callback that routes typed events to the WS pool.

        ApprovalRequestEvents are special-cased: instead of just broadcasting,
        the emitter routes through the approval bridge and resolves the
        embedded future with the user's decision.
        """
        async def emit(event: AnyEvent) -> None:
            if isinstance(event, ApprovalRequestEvent):
                if not self.broadcaster.has_connections():
                    if not event.future.done():
                        event.future.set_result({"behavior": "deny", "message": "No dashboard connected for approval."})
                    return
                result = await self.approval_bridge.request(
                    request_id=event.request_id,
                    send_fn=lambda: self.broadcaster.send_to_session(session_id, event.event, {
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
            await self.broadcaster.send_to_session(session_id, event.event, event.model_dump(mode="json"))
        return emit

    @typechecked
    async def send_browser_command(
        self, action: str, browser_id: str, tab_id: str, params: dict,
    ) -> dict:
        """BrowserCommandFn-compatible method that routes through the browser FutureBridge."""
        request_id: str = uuid4().hex
        if not self.broadcaster.has_connections():
            return {"error": "No dashboard connected. Open the dashboard to use browser tools."}
        return await self.browser_bridge.request(
            request_id=request_id,
            send_fn=lambda: self.broadcaster.broadcast("browser:command", {
                "request_id": request_id,
                "action": action,
                "browser_id": browser_id,
                "tab_id": tab_id,
                "params": params,
            }),
            timeout=30.0,
        )


COMMS_MANAGER = CommsManager()
