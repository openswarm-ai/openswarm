import asyncio
import json
import logging
from backend.builtin_server import WebSocket

from backend.apps.agents.seq_log import TERMINAL_STATUSES, seq_log

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections and bridges HITL approval requests.

    Every outbound event flows through the seq log so reconnecting
    clients can replay missed events. The send happens *under* the
    per-session lock yielded by `seq_log.stamp(...)`, which guarantees
    wire order matches seq order even under concurrent broadcasts.

    A WS disconnect (`disconnect_session`) ONLY removes the socket
    from the connection registry. It does NOT cancel the underlying
    agent task. The task lives on `agent_manager.tasks`; only an
    explicit `agent:stop`, REST `/close`, natural completion, or
    process shutdown ends a run.
    """

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
        """Broadcast a session event with monotonic sequencing.

        The send to every socket happens inside the seq_log lock so a
        slow/dead WS doesn't reorder events on the fast ones. If a
        single send raises (broken pipe, half-open socket), we log and
        continue — the ring buffer still has the event so the client
        will replay it on reconnect.

        For terminal status events (completed/stopped/error) we also
        atomically persist the payload to disk; a client that returns
        after a process restart can then resolve the spinner via
        `seq_log.load_terminal(...)` instead of being stuck.
        """
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
            # Persist terminal events under the lock so a concurrent
            # `agent:status: running` can't race past and overwrite
            # the disk file with a stale state.
            if event == "agent:status" and data.get("status") in TERMINAL_STATUSES:
                seq_log.persist_terminal(session_id, payload_str)

    async def replay_to(
        self, session_id: str, websocket: WebSocket, last_seq: int
    ) -> dict:
        """Replay buffered events with seq > last_seq to one socket.

        Returns a small ack envelope describing what happened so the
        caller (the WS handler) can send a `server:resume_ack` frame.

        Three cases:
          1. `events` non-empty: replay them in order; ack carries
             `from_seq`, `to_seq`.
          2. No buffer at all (process restarted, session evicted)
             but a persisted terminal exists: send it; ack signals
             `terminal_only=True`.
          3. `last_seq` predates the oldest buffered seq: emit
             `agent:gap_detected`; client REST-refreshes the session.
        """
        oldest, newest, events = seq_log.replay(session_id, last_seq)

        # Check for gap FIRST. If the client's last_seq is below the
        # buffer's oldest seq, we can't deliver everything they
        # missed — silently replaying only the in-buffer tail would
        # leave a hole in their state. Tell them to REST-refresh
        # instead, even if the tail looks safe to send.
        # Treat last_seq=0 as "fresh client" — they want a full
        # replay of whatever's in the buffer, not a gap signal.
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

        # Nothing in memory. Try a persisted terminal event.
        terminal = seq_log.load_terminal(session_id)
        if terminal is not None:
            try:
                await websocket.send_text(terminal)
            except Exception:
                pass
            return {"ok": True, "replayed": 1, "terminal_only": True}

        # Nothing missed, nothing to replay. Caller's caught up.
        return {
            "ok": True,
            "replayed": 0,
            "current_seq": newest if newest is not None else 0,
        }

    async def broadcast_global(self, event: str, data: dict):
        """Send a message to all global (dashboard) connections.

        Dashboard-scoped events don't go through the per-session seq
        log — they're not session-bound and the dashboard WS has its
        own resume story (full state refetch on reconnect).
        """
        payload = json.dumps({"event": event, "data": data})
        for ws in list(self.global_connections):
            try:
                await ws.send_text(payload)
            except Exception:
                pass

    async def send_approval_request(
        self, session_id: str, request_id: str, tool_name: str, tool_input: dict,
        timeout: float = 600.0,
    ) -> dict:
        """Send an approval request and wait for the user's response.

        Returns the approval decision dict. Times out after `timeout`
        seconds (default 10 minutes) so a forgotten request doesn't
        permanently park the agent.
        """
        future = asyncio.get_event_loop().create_future()
        self.pending_futures[request_id] = future

        await self.send_to_session(session_id, "agent:approval_request", {
            "request_id": request_id,
            "tool_name": tool_name,
            "tool_input": tool_input,
        })

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
