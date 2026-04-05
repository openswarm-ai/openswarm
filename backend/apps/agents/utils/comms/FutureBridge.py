import asyncio
from typing import Callable, Awaitable, Dict
from pydantic import BaseModel, Field
from typeguard import typechecked

class FutureBridge(BaseModel):
    """Async request/response bridge over WebSocket.

    Pattern: create a Future, send a question to the frontend,
    block until the frontend responds (or timeout).
    """

    p_pending: Dict[str, asyncio.Future] = Field(default_factory=dict)

    # TODO: add better type specing for the output of this function
    @typechecked
    async def request(
        self,
        request_id: str,
        send_fn: Callable[[], Awaitable[None]],
        timeout: float,
    ) -> dict:
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self.p_pending[request_id] = future
        await send_fn()
        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            print(f"[FutureBridge.request] Request {request_id} timed out after {timeout}s")
            return {"error": "Timed out"}
        finally:
            self.p_pending.pop(request_id, None)

    # TODO: add better type specing for the input of this function
    @typechecked
    def resolve(self, request_id: str, result: dict) -> None:
        future = self.p_pending.get(request_id)
        if future and not future.done():
            future.set_result(result)

APPROVAL_BRIDGE = FutureBridge()
BROWSER_BRIDGE = FutureBridge()
