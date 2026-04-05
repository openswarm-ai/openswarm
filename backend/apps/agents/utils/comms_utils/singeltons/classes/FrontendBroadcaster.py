import json
from fastapi import WebSocket
from typing import List
from typeguard import typechecked
from pydantic import BaseModel, Field


class FrontendBroadcaster(BaseModel):
    """Singleton WebSocket connection pool for broadcasting to dashboard clients."""

    p_connections: List[WebSocket] = Field(default_factory=list)

    @typechecked
    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.p_connections.append(ws)

    @typechecked
    def disconnect(self, ws: WebSocket) -> None:
        self.p_connections[:] = [c for c in self.p_connections if c is not ws]

    @typechecked
    def has_connections(self) -> bool:
        return len(self.p_connections) > 0

    @typechecked
    async def send_to_session(self, session_id: str, event: str, data: dict) -> None:
        payload: str = json.dumps({"event": event, "session_id": session_id, "data": data})
        for ws in self.p_connections:
            try:
                await ws.send_text(payload)
            except Exception:
                pass

    @typechecked
    async def broadcast(self, event: str, data: dict) -> None:
        payload: str = json.dumps({"event": event, "data": data})
        for ws in self.p_connections:
            try:
                await ws.send_text(payload)
            except Exception:
                pass