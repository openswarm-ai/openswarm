import json
from fastapi import WebSocket
from typing import List
from typeguard import typechecked

P_GLOBAL_CONNECTIONS: List[WebSocket] = []


@typechecked
async def connect_global(ws: WebSocket) -> None:
    await ws.accept()
    P_GLOBAL_CONNECTIONS.append(ws)


# USED-IN: make_session_emitter, send_browser_command
@typechecked
def has_global_connections() -> bool:
    return len(P_GLOBAL_CONNECTIONS) > 0


@typechecked
def disconnect_global(ws: WebSocket) -> None:
    P_GLOBAL_CONNECTIONS[:] = [c for c in P_GLOBAL_CONNECTIONS if c is not ws]


# USED-IN: make_session_emitter
@typechecked
async def send_to_session(session_id: str, event: str, data: dict) -> None:
    payload = json.dumps({"event": event, "session_id": session_id, "data": data})
    for ws in P_GLOBAL_CONNECTIONS:
        try:
            await ws.send_text(payload)
        except Exception:
            pass


# USED-IN: send_browser_command
@typechecked
async def broadcast_global(event: str, data: dict) -> None:
    payload = json.dumps({"event": event, "data": data})
    for ws in P_GLOBAL_CONNECTIONS:
        try:
            await ws.send_text(payload)
        except Exception:
            pass
