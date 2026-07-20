import asyncio
import json
import logging
from typing import Optional
from fastapi import WebSocket

from backend.apps.agents.core.seq_log import TERMINAL_STATUSES, seq_log

logger = logging.getLogger(__name__)

# Per-action browser-command timeouts (seconds). A hung tab makes EVERY command block to its timeout, so these bound how fast a freeze surfaces. Reads/clicks operate on an already-loaded page and should be quick; navigation legitimately loads the network so it gets a longer leash. Was a flat 30s, which let one wedged page spin for ~20 minutes across retries.
BROWSER_CMD_TIMEOUT_DEFAULT = 15.0   # modest load headroom; still "short" so a wedged tab fails fast
BROWSER_CMD_TIMEOUTS = {
    "navigate": 25.0,     # a real page load can be slow (more leash under load)
    "replay_route": 20.0, # an API fetch can be slow
    "wait": 12.0,         # smart-wait already caps itself well under this
    "perform_action": 35.0, # session-borrow shims pack navigate + wait + scrape into ONE command, so it needs more than navigate alone
    "browser_fetch": 32.0,  # offscreen window: load + settle + DOM read on an arbitrary (maybe slow/JS-heavy) page
    "browser_search": 45.0, # tries up to 3 engines sequentially, each a full load + settle
}
BROWSER_CMD_REBROADCAST_S = 3.0
# A CPU-starved renderer can briefly drop its WS (a missed heartbeat) and the frontend auto-reconnects a beat later; bridge that gap instead of hard-failing a live run into it. Short enough that a genuinely-closed window still fails quickly (and no LLM turns are ever burned waiting); long enough to ride out a reconnect even on a loaded machine.
P_WS_RECONNECT_WAIT_S = 8.0


def slim_status_data(event: str, data: dict) -> dict:
    """agent:status frames carry session METADATA, never the transcript: every message already
    reaches clients as its own agent:message event (and the stream), so re-shipping full history
    per status flip was pure duplication, and replayed stale copies rolled clients backwards.
    Preview fields mirror p_session_list_item so collapsed-card previews keep working."""
    if event != "agent:status":
        return data
    sess = data.get("session")
    if not isinstance(sess, dict) or not sess.get("messages"):
        return data
    messages = sess["messages"]
    last = messages[-1].get("content", "")
    first_user = next((m.get("content") for m in messages if m.get("role") == "user"), "")
    slim = dict(sess)
    slim["messages"] = []
    slim["last_message_preview"] = last[:120] if isinstance(last, str) else ""
    slim["first_user_message"] = first_user[:200] if isinstance(first_user, str) else ""
    slim["message_count"] = len(messages)
    out = dict(data)
    out["session"] = slim
    return out


async def await_reconnect(has_conn) -> bool:
    """Poll up to P_WS_RECONNECT_WAIT_S for a dashboard socket to (re)appear.
    `has_conn` is a 0-arg callable returning truthy when connected."""
    if has_conn():
        return True
    waited = 0.0
    while waited < P_WS_RECONNECT_WAIT_S:
        await asyncio.sleep(0.5)
        waited += 0.5
        if has_conn():
            return True
    return bool(has_conn())


class ConnectionManager:
    """Manages WebSocket connections and HITL approval bridging; events flow through seq_log so reconnects can replay."""

    def __init__(self):
        self.connections: dict[str, list[WebSocket]] = {}
        self.global_connections: list[WebSocket] = []
        # Which dashboard each global socket is currently showing, keyed by id(websocket). active_dashboard_id is the last one activated (the window the user is looking at most recently); a scheduled run targets it so its browser card spawns where the renderer can render it.
        self.global_dashboard_ids: dict[int, str] = {}
        self.active_dashboard_id: Optional[str] = None
        self.pending_futures: dict[str, asyncio.Future] = {}
        self.browser_futures: dict[str, asyncio.Future] = {}
        # The Electron MAIN process (not the renderer) holds a single WS here. Cookie reads route to it so they don't ride the renderer, which macOS throttles when the window is backgrounded (the source of the session-borrow bridge's intermittent timeouts).
        self.main_connection: Optional[WebSocket] = None

    async def connect_session(self, session_id: str, websocket: WebSocket):
        await websocket.accept()
        if session_id not in self.connections:
            self.connections[session_id] = []
        self.connections[session_id].append(websocket)

    async def connect_global(self, websocket: WebSocket):
        await websocket.accept()
        self.global_connections.append(websocket)

    async def connect_main(self, websocket: WebSocket):
        """Register the single Electron-main bridge socket (replaces any stale prior one)."""
        await websocket.accept()
        self.main_connection = websocket

    def disconnect_main(self, websocket: WebSocket):
        if self.main_connection is websocket:
            self.main_connection = None

    def disconnect_session(self, session_id: str, websocket: WebSocket):
        if session_id in self.connections:
            self.connections[session_id] = [
                ws for ws in self.connections[session_id] if ws != websocket
            ]
            if not self.connections[session_id]:
                del self.connections[session_id]

    def set_active_dashboard(self, websocket: WebSocket, dashboard_id: str):
        """Record which dashboard a renderer is showing; last activation wins."""
        self.global_dashboard_ids[id(websocket)] = dashboard_id
        self.active_dashboard_id = dashboard_id

    def disconnect_global(self, websocket: WebSocket):
        self.global_connections = [
            ws for ws in self.global_connections if ws != websocket
        ]
        # Drop this socket's active-dashboard pointer; if it owned the global one, fall back to any window still connected so a closed tab doesn't leave a stale target.
        self.global_dashboard_ids.pop(id(websocket), None)
        if self.active_dashboard_id not in self.global_dashboard_ids.values():
            self.active_dashboard_id = next(iter(self.global_dashboard_ids.values()), None)

    async def send_to_session(self, session_id: str, event: str, data: dict):
        """Broadcast a session event with monotonic sequencing; terminal statuses also persist to disk."""
        data = slim_status_data(event, data)
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

        # Outside the stamp lock so analytics can't gate the broadcast; replays go via ws.send_text, so reconnects don't double-count.
        if event == "agent:message":
            try:
                from backend.apps.service.analytics.agent_bridge import bridge_agent_message, BroadcastMessage
                bridge_agent_message(session_id, BroadcastMessage.model_validate(data.get("message") or {}))
            except Exception:
                logger.debug("agent:message analytics bridge failed", exc_info=True)

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
            # Drop already-resolved approval requests from the replay. The ring buffer holds every event we ever stamped, including the original `agent:approval_request`. Without this filter, a client that reconnects (e.g. after navigating away and back, which re-mounts AgentChat with last_seq=0) re-fires every past approval as if it were live, but the backing future was popped from pending_futures the moment the user answered, so the resurrected card is a dead no-op. Lifecycle is simple: send_approval_request() inserts into pending_futures BEFORE the event is stamped, and resolve_approval()/timeout/cancel all pop it; so "in pending_futures" is the authoritative is-still-live signal for the request_id. A process restart wipes pending_futures, which is correct because reconcile_on_startup also marks waiting_approval sessions as stopped so there's nothing to answer anyway.
            events = self.p_filter_stale_approvals(events)
            events = self.p_strip_replayed_closes(events)
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

        # Live log and the client is at (or past) the top: caught up, nothing to send. Without this, every cursor-seeded reconnect got the persisted terminal frame re-sent as "replay".
        if newest is not None and last_seq >= newest and newest > 0:
            return {"ok": True, "replayed": 0, "current_seq": newest}

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

    def p_strip_replayed_closes(self, events: list[str]) -> list[str]:
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

    def p_filter_stale_approvals(self, events: list[str]) -> list[str]:
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
        payload = json.dumps({"event": event, "data": slim_status_data(event, data)})
        dead: list[WebSocket] = []
        for ws in list(self.global_connections):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        # A renderer that reloaded without a clean close leaves a half-open socket here; a browser command broadcast into it is lost forever (the future then times out). Drop any socket that fails a send so the next command only targets live renderers.
        for ws in dead:
            self.disconnect_global(ws)

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
        if not self.global_connections and not await await_reconnect(lambda: bool(self.global_connections)):
            return {"error": "No dashboard is connected. Open the dashboard to use browser tools."}

        loop = asyncio.get_event_loop()
        future = loop.create_future()
        self.browser_futures[request_id] = future

        payload = {
            "request_id": request_id,
            "action": action,
            "browser_id": browser_id,
            "tab_id": tab_id,
            "params": params,
        }

        try:
            # Bound each command so a wedged tab can't block for 30s (the cost that turned one hung LinkedIn page into a 20-minute spin). Navigation legitimately takes longer than reads/clicks on an already-loaded page, so it gets a longer leash; everything else fails fast. A one-off slow command just times out and the next success resets the agent's streak, so only a SUSTAINED hang trips the fast-fail abort.
            timeout = BROWSER_CMD_TIMEOUTS.get(action, BROWSER_CMD_TIMEOUT_DEFAULT)
            deadline = loop.time() + timeout
            # Re-broadcast until a client answers: a silently-dead dashboard socket takes up to ~35s of heartbeat to notice, and a command sent into that gap is lost forever (broadcast skips seq_log). The renderer dedupes by request_id so re-sends can't double-act.
            while True:
                await self.broadcast_global("browser:command", payload)
                remaining = deadline - loop.time()
                if remaining <= 0:
                    return {"error": "Browser command timed out"}
                done, _ = await asyncio.wait(
                    {future}, timeout=min(BROWSER_CMD_REBROADCAST_S, remaining)
                )
                if done:
                    return future.result()
        finally:
            self.browser_futures.pop(request_id, None)

    async def send_main_command(self, request_id: str, action: str, params: dict) -> dict:
        """Send a command straight to the throttle-free Electron MAIN socket (cookie reads only); returns a not-connected error so the caller can fall back to the renderer."""
        ws = self.main_connection
        if ws is None:
            return {"error": "Electron main bridge not connected"}
        loop = asyncio.get_event_loop()
        future = loop.create_future()
        self.browser_futures[request_id] = future
        payload = {"request_id": request_id, "action": action, "browser_id": "", "tab_id": "", "params": params}
        try:
            await ws.send_text(json.dumps({"event": "browser:command", "data": payload}))
            done, _ = await asyncio.wait({future}, timeout=BROWSER_CMD_TIMEOUTS.get(action, BROWSER_CMD_TIMEOUT_DEFAULT))
            if done:
                return future.result()
            return {"error": "Electron main bridge timed out"}
        except Exception as e:
            self.disconnect_main(ws)
            return {"error": f"Electron main bridge send failed: {e}"}
        finally:
            self.browser_futures.pop(request_id, None)

    def resolve_browser_command(self, request_id: str, result: dict):
        """Resolve a pending browser command Future with the frontend's result."""
        future = self.browser_futures.get(request_id)
        if future and not future.done():
            future.set_result(result)


ws_manager = ConnectionManager()
