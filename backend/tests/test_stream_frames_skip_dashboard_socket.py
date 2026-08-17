"""Stream frames must never ride the dashboard socket: its only client (dashboardWs,
skipStreamEvents=true) drops them unread, so the fan-out taxed the renderer with a JSON parse per
streamed token and doubled the work for an expanded chat (its own socket carries the real copy).
Both directions pinned: deltas stay session-only, and every other event still reaches the
dashboard socket, or narrator pills and status chips would go blind."""

import pytest
from unittest.mock import AsyncMock

from backend.apps.agents.core.ws_manager import ws_manager


class P_FakeWs:
    def __init__(self):
        self.sent = []

    async def send_text(self, payload: str):
        self.sent.append(payload)


@pytest.fixture()
def wired():
    session_ws = P_FakeWs()
    dashboard_ws = P_FakeWs()
    ws_manager.connections.setdefault("sess-1", []).append(session_ws)
    ws_manager.global_connections.append(dashboard_ws)
    yield session_ws, dashboard_ws
    ws_manager.connections.get("sess-1", []).remove(session_ws)
    if not ws_manager.connections.get("sess-1"):
        ws_manager.connections.pop("sess-1", None)
    ws_manager.global_connections.remove(dashboard_ws)


@pytest.mark.asyncio
async def test_stream_frames_reach_the_session_socket_only(wired):
    session_ws, dashboard_ws = wired
    for event in ("agent:stream_start", "agent:stream_delta", "agent:stream_end"):
        await ws_manager.send_to_session("sess-1", event, {"message_id": "m1", "delta": "hi"})
    assert len(session_ws.sent) == 3, "the chat's own socket must carry the full stream"
    assert dashboard_ws.sent == [], "the dashboard socket must never see a stream frame"


@pytest.mark.asyncio
async def test_every_other_event_still_fans_out_globally(wired):
    session_ws, dashboard_ws = wired
    await ws_manager.send_to_session("sess-1", "agent:status", {"status": "running"})
    await ws_manager.send_to_session("sess-1", "agent:message", {"message": {}})
    assert len(session_ws.sent) == 2
    assert len(dashboard_ws.sent) == 2, "non-stream events power collapsed cards; they must keep flowing"
