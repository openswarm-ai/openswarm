import json
from fastapi import WebSocket
from typing import Dict, List
from typeguard import typechecked

P_SESSION_CONNECTIONS: Dict[str, List[WebSocket]] = {}
P_GLOBAL_CONNECTIONS: List[WebSocket] = []


@typechecked
async def connect_session(session_id: str, ws: WebSocket) -> None:
    await ws.accept()
    P_SESSION_CONNECTIONS.setdefault(session_id, []).append(ws)

@typechecked
async def connect_global(ws: WebSocket) -> None:
    await ws.accept()
    P_GLOBAL_CONNECTIONS.append(ws)


@typechecked
def disconnect_session(session_id: str, ws: WebSocket) -> None:
    conns = P_SESSION_CONNECTIONS.get(session_id)
    if not conns:
        return
    conns[:] = [c for c in conns if c is not ws]
    if not conns:
        del P_SESSION_CONNECTIONS[session_id]


@typechecked
def has_global_connections() -> bool:
    return len(P_GLOBAL_CONNECTIONS) > 0


@typechecked
def disconnect_global(ws: WebSocket) -> None:
    P_GLOBAL_CONNECTIONS[:] = [c for c in P_GLOBAL_CONNECTIONS if c is not ws]


@typechecked
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


@typechecked
async def broadcast_global(event: str, data: dict) -> None:
    payload = json.dumps({"event": event, "data": data})
    for ws in P_GLOBAL_CONNECTIONS:
        try:
            await ws.send_text(payload)
        except Exception:
            pass
