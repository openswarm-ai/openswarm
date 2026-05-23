import asyncio
import json
import logging
from fastapi import WebSocket

from backend.apps.agents.core.seq_log import TERMINAL_STATUSES, seq_log

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections and HITL approval bridging; events flow through seq_log so reconnects can replay."""

    def __init__(self):
        self.connections: dict[str, list[WebSocket]] = {}
        self.global_connections: list[WebSocket] = []
        self.pending_futures: dict[str, asyncio.Future] = {}
        self.browser_futures: dict[str, asyncio.Future] = {}

    async def connect_session(self, session_id: str, websocket: WebSocket):
        await websocket.accept()
        if session_id not in self.connections:
            self.connections[session_id] = []
        self.connections[session_id].append(websocket)

    async def connect_global(self, websocket: WebSocket):
        await websocket.accept()
        self.global_connections.append(websocket)

    def disconnect_session(self, session_id: str, websocket: WebSocket):
        if session_id in self.connections:
            self.connections[session_id] = [
                ws for ws in self.connections[session_id] if ws != websocket
            ]
            if not self.connections[session_id]:
                del self.connections[session_id]

    def disconnect_global(self, websocket: WebSocket):
        self.global_connections = [
            ws for ws in self.global_connections if ws != websocket
        ]

    async def send_to_session(self, session_id: str, event: str, data: dict):
        """Broadcast a session event with monotonic sequencing; terminal statuses also persist to disk."""
        async with seq_log.stamp(session_id, event, data) as (seq, payload_str):
            for ws in list(self.connections.get(session_id, [])):
                try:
                    await ws.send_text(payload_str)
                except Exception:
                    logger.debug("send_to_session: send failed (will retry on reconnect)", exc_info=True)
            for ws in list(self.global_connections):
                try:
                    await ws.send_text(payload_str)
                except Exception:
                    logger.debug("send_to_session: global send failed", exc_info=True)
            # Persist under the lock so a concurrent running status can't race past and overwrite with stale state.
            if event == "agent:status" and data.get("status") in TERMINAL_STATUSES:
                seq_log.persist_terminal(session_id, payload_str)

    async def replay_to(
        self, session_id: str, websocket: WebSocket, last_seq: int
    ) -> dict:
        """Replay buffered events with seq > last_seq; returns ack envelope for the resume handshake."""
        oldest, newest, events = seq_log.replay(session_id, last_seq)

        # Gap-check first: if last_seq predates the buffer, signal REST-refresh; last_seq=0 means fresh client (full replay).
        if last_seq > 0 and oldest is not None and last_seq < oldest - 1:
            gap_payload = json.dumps({
                "event": "agent:gap_detected",
                "session_id": session_id,
                "data": {
                    "session_id": session_id,
                    "oldest_seq": oldest,
                    "newest_seq": newest,
                    "client_seq": last_seq,
                },
            })
            try:
                await websocket.send_text(gap_payload)
            except Exception:
                pass
            return {
                "ok": False,
                "reason": "gap",
                "oldest_seq": oldest,
                "newest_seq": newest,
            }

        if events:
            # Drop already-resolved approval requests from the replay. The
            # ring buffer holds every event we ever stamped, including the
            # original `agent:approval_request`. Without this filter, a
            # client that reconnects (e.g. after navigating away and back,
            # which re-mounts AgentChat with last_seq=0) re-fires every
            # past approval as if it were live, but the backing future was
            # popped from pending_futures the moment the user answered, so
            # the resurrected card is a dead no-op. Lifecycle is simple:
            # send_approval_request() inserts into pending_futures BEFORE
            # the event is stamped, and resolve_approval()/timeout/cancel
            # all pop it; so "in pending_futures" is the authoritative
            # is-still-live signal for the request_id. A process restart
            # wipes pending_futures, which is correct because
            # reconcile_on_startup also marks waiting_approval sessions as
            # stopped so there's nothing to answer anyway.
            events = self._filter_stale_approvals(events)
            events = self._strip_replayed_closes(events)
            for s in events:
                try:
                    await websocket.send_text(s)
                except Exception:
                    logger.debug("replay_to: send failed", exc_info=True)
                    break
            return {
                "ok": True,
                "replayed": len(events),
                "from_seq": last_seq,
                "to_seq": newest,
            }

        terminal = seq_log.load_terminal(session_id)
        if terminal is not None:
            try:
                await websocket.send_text(terminal)
            except Exception:
                pass
            return {"ok": True, "replayed": 1, "terminal_only": True}

        return {
            "ok": True,
            "replayed": 0,
            "current_seq": newest if newest is not None else 0,
        }

    def _strip_replayed_closes(self, events: list[str]) -> list[str]:
        """Drop `agent:closed` events from a replay buffer.

        agent:closed is a transition event ("session JUST closed") whose
        frontend reducer (closeSessionFromWs) destructively deletes the
        session from state.sessions. Replaying it on a fresh client (e.g.
        a user who just clicked the closed chat in history) deletes the
        session they're trying to open. The current closed state is
        already conveyed by the REST hydrate (status=stopped, closed_at
        set) and by the latest agent:status event in the replay, so
        suppressing the transition replay is non-lossy.
        """
        out: list[str] = []
        for payload_str in events:
            try:
                parsed = json.loads(payload_str)
            except (ValueError, TypeError):
                out.append(payload_str)
                continue
            if parsed.get("event") == "agent:closed":
                continue
            out.append(payload_str)
        return out

    def _filter_stale_approvals(self, events: list[str]) -> list[str]:
        """Return events minus any `agent:approval_request` whose request_id
        is no longer in pending_futures. JSON parse is per-event but replay
        only runs on (re)connect, so it isn't a hot path.
        """
        alive = self.pending_futures
        out: list[str] = []
        for payload_str in events:
            try:
                parsed = json.loads(payload_str)
            except (ValueError, TypeError):
                out.append(payload_str)
                continue
            if parsed.get("event") != "agent:approval_request":
                out.append(payload_str)
                continue
            data = parsed.get("data") or {}
            request_id = data.get("request_id")
            if request_id and request_id in alive:
                out.append(payload_str)
        return out

    async def broadcast_global(self, event: str, data: dict):
        """Send to all dashboard connections; bypasses seq_log (dashboard resumes via full state refetch)."""
        payload = json.dumps({"event": event, "data": data})
        for ws in list(self.global_connections):
            try:
                await ws.send_text(payload)
            except Exception:
                pass

    async def send_approval_request(
        self, session_id: str, request_id: str, tool_name: str, tool_input: dict,
        timeout: float = 600.0,
        sensitive_pattern: str | None = None,
        sensitive_label: str | None = None,
        sensitive_why: str | None = None,
    ) -> dict:
        """Send an approval request and wait for the user's decision; 10-minute timeout prevents permanent park."""
        future = asyncio.get_event_loop().create_future()
        self.pending_futures[request_id] = future

        payload: dict = {
            "request_id": request_id,
            "tool_name": tool_name,
            "tool_input": tool_input,
        }
        if sensitive_pattern:
            payload["sensitive_pattern"] = sensitive_pattern
            payload["sensitive_label"] = sensitive_label
            payload["sensitive_why"] = sensitive_why
        await self.send_to_session(session_id, "agent:approval_request", payload)

        try:
            result = await asyncio.wait_for(future, timeout=timeout)
            return result
        except asyncio.TimeoutError:
            logger.warning("Approval %s for session %s timed out after %ss", request_id, session_id, timeout)
            return {"behavior": "deny", "message": "Approval timed out"}
        finally:
            self.pending_futures.pop(request_id, None)

    def resolve_approval(self, request_id: str, decision: dict):
        """Resolve a pending approval Future with the user's decision."""
        future = self.pending_futures.get(request_id)
        if future and not future.done():
            future.set_result(decision)

    async def send_browser_command(
        self, request_id: str, action: str, browser_id: str, params: dict, tab_id: str = ""
    ) -> dict:
        """Send a browser command to the frontend and wait for the result."""
        if not self.global_connections:
            return {"error": "No dashboard is connected. Open the dashboard to use browser tools."}

        future = asyncio.get_event_loop().create_future()
        self.browser_futures[request_id] = future

        await self.broadcast_global("browser:command", {
            "request_id": request_id,
            "action": action,
            "browser_id": browser_id,
            "tab_id": tab_id,
            "params": params,
        })

        try:
            result = await asyncio.wait_for(future, timeout=30.0)
            return result
        except asyncio.TimeoutError:
            return {"error": "Browser command timed out"}
        finally:
            self.browser_futures.pop(request_id, None)

    def resolve_browser_command(self, request_id: str, result: dict):
        """Resolve a pending browser command Future with the frontend's result."""
        future = self.browser_futures.get(request_id)
        if future and not future.done():
            future.set_result(result)


ws_manager = ConnectionManager()
