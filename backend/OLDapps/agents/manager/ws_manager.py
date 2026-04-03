import asyncio
import json
import logging
from fastapi import WebSocket

logger = logging.getLogger(__name__)

class ConnectionManager:
    """Manages WebSocket connections and bridges HITL approval requests."""
    
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
        """Send a message to all connections watching a specific session."""
        payload = json.dumps({"event": event, "session_id": session_id, "data": data})
        for ws in self.connections.get(session_id, []):
            try:
                await ws.send_text(payload)
            except Exception:
                pass
        for ws in self.global_connections:
            try:
                await ws.send_text(payload)
            except Exception:
                pass

    async def broadcast_global(self, event: str, data: dict):
        """Send a message to all global (dashboard) connections."""
        payload = json.dumps({"event": event, "data": data})
        for ws in self.global_connections:
            try:
                await ws.send_text(payload)
            except Exception:
                pass

    async def send_approval_request(
        self, session_id: str, request_id: str, tool_name: str, tool_input: dict,
        timeout: float = 600.0,
    ) -> dict:
        """Send an approval request and wait for the user's response.
        Returns the approval decision dict.  Times out after *timeout* seconds
        (default 10 minutes) to prevent permanently stuck agents."""
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

    # ------------------------------------------------------------------
    # Typed event emitters
    # ------------------------------------------------------------------

    async def emit_status(self, session_id: str, status: str, session=None):
        data: dict = {"session_id": session_id, "status": status}
        if session is not None:
            data["session"] = session.model_dump(mode="json") if hasattr(session, "model_dump") else session
        await self.send_to_session(session_id, "agent:status", data)

    async def emit_message(self, session_id: str, message):
        dumped = message.model_dump(mode="json") if hasattr(message, "model_dump") else message
        await self.send_to_session(session_id, "agent:message", {
            "session_id": session_id, "message": dumped,
        })

    async def emit_cost_update(self, session_id: str, cost_usd: float):
        await self.send_to_session(session_id, "agent:cost_update", {
            "session_id": session_id, "cost_usd": cost_usd,
        })

    async def emit_stream_start(self, session_id: str, message_id: str, role: str, tool_name: str = ""):
        payload: dict = {"session_id": session_id, "message_id": message_id, "role": role}
        if tool_name:
            payload["tool_name"] = tool_name
        await self.send_to_session(session_id, "agent:stream_start", payload)

    async def emit_stream_delta(self, session_id: str, message_id: str, delta: str):
        await self.send_to_session(session_id, "agent:stream_delta", {
            "session_id": session_id, "message_id": message_id, "delta": delta,
        })

    async def emit_stream_end(self, session_id: str, message_id: str):
        await self.send_to_session(session_id, "agent:stream_end", {
            "session_id": session_id, "message_id": message_id,
        })

    async def emit_branch_created(self, session_id: str, branch, active_branch_id: str):
        dumped = branch.model_dump(mode="json") if hasattr(branch, "model_dump") else branch
        await self.send_to_session(session_id, "agent:branch_created", {
            "session_id": session_id, "branch": dumped, "active_branch_id": active_branch_id,
        })

    async def emit_branch_switched(self, session_id: str, active_branch_id: str):
        await self.send_to_session(session_id, "agent:branch_switched", {
            "session_id": session_id, "active_branch_id": active_branch_id,
        })

    async def emit_name_updated(self, session_id: str, name: str):
        await self.send_to_session(session_id, "agent:name_updated", {
            "session_id": session_id, "name": name,
        })

    async def emit_group_meta_updated(
        self, session_id: str, group_id: str, name: str, svg: str, is_refined: bool,
    ):
        await self.send_to_session(session_id, "agent:group_meta_updated", {
            "session_id": session_id, "group_id": group_id,
            "name": name, "svg": svg, "is_refined": is_refined,
        })

    async def emit_closed(self, session_id: str, session):
        await self.send_to_session(session_id, "agent:closed", {
            "session_id": session_id, "status": session.status,
            "name": session.name, "model": session.model, "mode": session.mode,
            "created_at": session.created_at.isoformat() if session.created_at else None,
            "closed_at": session.closed_at.isoformat() if session.closed_at else None,
            "cost_usd": session.cost_usd, "dashboard_id": session.dashboard_id,
        })


ws_manager = ConnectionManager()
