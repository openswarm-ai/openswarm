"""WebSocket connection pool and async future bridges.

Three concerns, one module:

1. Connection pool — holds WebSocket objects, delivers JSON payloads.
2. FutureBridge — generic async request/response over WebSocket.
3. Bridge instances — approval_bridge and browser_bridge.
"""

import asyncio
import json
from typing import Callable, Awaitable

from fastapi import WebSocket

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# 1. Connection pool
# ---------------------------------------------------------------------------

P_SESSION_CONNECTIONS: dict[str, list[WebSocket]] = {}
P_GLOBAL_CONNECTIONS: list[WebSocket] = []


async def connect_session(session_id: str, ws: WebSocket) -> None:
    await ws.accept()
    P_SESSION_CONNECTIONS.setdefault(session_id, []).append(ws)


async def connect_global(ws: WebSocket) -> None:
    await ws.accept()
    P_GLOBAL_CONNECTIONS.append(ws)


def disconnect_session(session_id: str, ws: WebSocket) -> None:
    conns = P_SESSION_CONNECTIONS.get(session_id)
    if not conns:
        return
    conns[:] = [c for c in conns if c is not ws]
    if not conns:
        del P_SESSION_CONNECTIONS[session_id]


def has_global_connections() -> bool:
    return len(P_GLOBAL_CONNECTIONS) > 0


def disconnect_global(ws: WebSocket) -> None:
    P_GLOBAL_CONNECTIONS[:] = [c for c in P_GLOBAL_CONNECTIONS if c is not ws]


async def send_to_session(session_id: str, event: str, data: dict) -> None:
    payload = json.dumps({"event": event, "session_id": session_id, "data": data})
    for ws in P_SESSION_CONNECTIONS.get(session_id, []):
        try:
            await ws.send_text(payload)
        except Exception:
            pass
    for ws in P_GLOBAL_CONNECTIONS:
        try:
            await ws.send_text(payload)
        except Exception:
            pass


async def broadcast_global(event: str, data: dict) -> None:
    payload = json.dumps({"event": event, "data": data})
    for ws in P_GLOBAL_CONNECTIONS:
        try:
            await ws.send_text(payload)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 2. FutureBridge
# ---------------------------------------------------------------------------

class FutureBridge(BaseModel):
    """Async request/response bridge over WebSocket.

    Pattern: create a Future, send a question to the frontend,
    block until the frontend responds (or timeout).
    """

    p_pending: dict[str, asyncio.Future] = Field(default_factory=dict)

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

    def resolve(self, request_id: str, result: dict) -> None:
        future = self.p_pending.get(request_id)
        if future and not future.done():
            future.set_result(result)


# ---------------------------------------------------------------------------
# 3. Bridge instances
# ---------------------------------------------------------------------------

APPROVAL_BRIDGE = FutureBridge()
BROWSER_BRIDGE = FutureBridge()
