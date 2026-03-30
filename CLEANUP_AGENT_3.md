# Agent 3: DRY Up Cross-Cutting Patterns (Phase 2)

## Context

You are cleaning up the OpenSwarm codebase. This is agent 3 of 4. Agents 1 and 2 have already completed:

- **Phase 0:** Shared utilities in `backend/apps/common/` (json_store, model_registry, mcp_utils, llm_helpers)
- **Phase 1:** Split god objects — `agent_manager.py`, `tools_lib.py`, `outputs.py`, `browser_agent.py` are now modular packages/files

**Rules:**
- Every file you create or modify must be <250 lines of code
- Keep code DRY
- Do NOT touch `9router/`, `debugger/`, or `frontend/`
- Do NOT touch tests
- Verify the app still starts after each major change

---

## Task 2A: Extract Shared Approval Flow

**Problem:** Two places implement independent HITL (human-in-the-loop) approval request patterns:

1. **`agent_manager.py`** (now possibly in `agent_loop.py` after Phase 1 split) — `_request_user_approval()` function:
   - Creates an `ApprovalRequest`
   - Appends to `session.pending_approvals`
   - Sets `session.status = "waiting_approval"`
   - Sends WS status event
   - Fires analytics event
   - Waits for decision via `ws_manager.send_approval_request()`
   - Fires another analytics event with latency
   - Removes from pending approvals
   - Restores `session.status = "running"`
   - Sends WS status event

2. **`browser_agent.py`** (now possibly in `browser/executor.py`) — `_request_browser_approval()`:
   - Same pattern but without analytics events and with a timeout

**What to do:**

1. Create `backend/apps/agents/approval.py` (~80 lines):

```python
async def request_approval(
    session: AgentSession,
    tool_name: str,
    tool_input: dict,
    timeout: float | None = None,
    track_analytics: bool = True,
) -> dict:
    """Unified HITL approval flow.
    
    Creates an ApprovalRequest, sends it via WebSocket, waits for the user's 
    decision, cleans up, and returns the decision dict.
    
    Returns: {"behavior": "allow"|"deny", "message": ..., "updated_input": ...}
    """
```

2. Replace both implementations with calls to this shared function.

3. Make sure the analytics tracking is optional (browser agents don't currently track approval analytics).

---

## Task 2B: Extract WebSocket Event Helpers

**Problem:** Throughout the codebase (especially `agent_manager.py` / `agent_loop.py` / `browser_agent.py`), there are 30+ calls that look like:

```python
await ws_manager.send_to_session(session_id, "agent:status", {
    "session_id": session_id,
    "status": "running",
    "session": session.model_dump(mode="json"),
})
```

The payload construction is repeated identically every time for each event type.

**What to do:**

Add typed convenience methods to `backend/apps/agents/ws_manager.py`. The file is currently 126 lines so there's room:

```python
async def emit_status(self, session_id: str, status: str, session: AgentSession):
    await self.send_to_session(session_id, "agent:status", {
        "session_id": session_id,
        "status": status,
        "session": session.model_dump(mode="json"),
    })

async def emit_message(self, session_id: str, message: Message):
    await self.send_to_session(session_id, "agent:message", {
        "session_id": session_id,
        "message": message.model_dump(mode="json"),
    })

async def emit_cost_update(self, session_id: str, cost_usd: float):
    await self.send_to_session(session_id, "agent:cost_update", {
        "session_id": session_id,
        "cost_usd": cost_usd,
    })

async def emit_stream_start(self, session_id: str, message_id: str, role: str, tool_name: str = ""):
    payload = {"session_id": session_id, "message_id": message_id, "role": role}
    if tool_name:
        payload["tool_name"] = tool_name
    await self.send_to_session(session_id, "agent:stream_start", payload)

async def emit_stream_delta(self, session_id: str, message_id: str, delta: str):
    await self.send_to_session(session_id, "agent:stream_delta", {
        "session_id": session_id,
        "message_id": message_id,
        "delta": delta,
    })

async def emit_stream_end(self, session_id: str, message_id: str):
    await self.send_to_session(session_id, "agent:stream_end", {
        "session_id": session_id,
        "message_id": message_id,
    })
```

Then do a find-and-replace across all files that construct these payloads manually. Replace with the typed helpers. This is a mechanical change — just make sure every event type is covered.

**Important:** If `ws_manager.py` exceeds 250 lines after adding these helpers, split it into `ws_manager.py` (connection management) and `ws_events.py` (typed event emitters).

---

## Task 2C: Move Subscription Routes to New Sub-App

**Problem:** `backend/apps/agents/agents.py` (305 lines) contains ~120 lines of 9Router/subscription endpoints (lines 186-305) that have nothing to do with agent sessions:
- `subscriptions_status()`
- `subscriptions_connect()`
- `subscriptions_poll()`
- `subscriptions_exchange()`
- `subscriptions_models()`
- `subscriptions_disconnect()`

**What to do:**

1. Create `backend/apps/subscriptions/__init__.py` (empty)
2. Create `backend/apps/subscriptions/subscriptions.py` (~130 lines):
   - Move all 6 subscription endpoints here
   - Create a new SubApp: `subscriptions = SubApp("subscriptions", subscriptions_lifespan)`
   - The lifespan can be a simple no-op (or move the 9Router auto-start from analytics lifespan here if it makes more sense)

3. Update `backend/main.py`:
   - Import the new `subscriptions` sub-app
   - Add it to the `MainApp` list

4. Remove the subscription endpoints from `agents.py`. This should bring `agents.py` down to ~185 lines.

5. **Frontend impact:** The frontend calls these endpoints at `/api/agents/subscriptions/*`. The new path will be `/api/subscriptions/*`. Search the frontend for these API paths and update them:
   ```bash
   grep -r "api/agents/subscriptions" frontend/src/
   ```
   Update all matches to use `/api/subscriptions/` instead.

---

## Task 2D: Clean Up `main.py`

**Problem:** `backend/main.py` (256 lines) has inline WebSocket handlers, OAuth callback endpoints, browser-agent HTTP endpoint, and invoke-agent HTTP endpoint that should live in their respective sub-apps.

**What to do:**

### Move WebSocket handlers

The two WebSocket handlers (`websocket_session` and `websocket_dashboard`, lines 41-104) can't easily move to a SubApp router because FastAPI WebSocket routes need to be on the main app. However, the message dispatch logic inside them can be extracted.

Create `backend/apps/agents/ws_routes.py` (~80 lines):

```python
async def handle_session_message(session_id: str, event: str, payload: dict):
    """Dispatch a WebSocket message for a session."""
    if event == "agent:send_message":
        from backend.apps.agents.agent_manager import agent_manager
        await agent_manager.send_message(...)
    elif event == "agent:approval_response":
        ...
    elif event == "agent:edit_message":
        ...
    elif event == "agent:stop":
        ...

async def handle_dashboard_message(event: str, payload: dict):
    """Dispatch a WebSocket message for the dashboard."""
    ...
```

Then `main.py`'s WebSocket handlers become thin wrappers:
```python
@app.websocket("/ws/agents/{session_id}")
async def websocket_session(websocket: WebSocket, session_id: str):
    await ws_manager.connect_session(session_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            await handle_session_message(session_id, msg.get("event"), msg.get("data", {}))
    except WebSocketDisconnect:
        ws_manager.disconnect_session(session_id, websocket)
```

### Move HTTP endpoints

- `/api/browser/command` (lines 107-122) → Move to `agents/browser/` as a route on the agents router, or keep in main.py if it needs to be at the root level
- `/api/browser-agent/run` (lines 172-196) → Move to agents router
- `/api/invoke-agent/run` (lines 199-227) → Move to agents router
- `/api/subscriptions/pending/{state}` (lines 125-136) → Move to subscriptions sub-app
- `/api/subscriptions/callback` (lines 139-169) → Move to subscriptions sub-app (or tools_lib OAuth if it's OAuth-related)

### Target state for `main.py` (~80 lines):

```python
# Imports
# Create MainApp with all sub-apps
# CORS middleware
# WebSocket routes (thin wrappers)
# if __name__ == "__main__": uvicorn
```

---

## Verification

After all tasks are complete:

1. Verify no file in `backend/` exceeds 250 lines:
   ```bash
   find backend -name '*.py' -not -path '*/__pycache__/*' -not -path '*/test*' | xargs wc -l | sort -rn | head -20
   ```

2. Verify the app starts:
   ```bash
   cd backend && python -c "from backend.main import app; print('App created OK')"
   ```

3. Verify the new subscriptions sub-app is registered:
   ```bash
   python -c "from backend.main import app; routes = [r.path for r in app.routes]; print([r for r in routes if 'subscription' in r])"
   ```

4. Check that no frontend API calls are broken by searching for old paths:
   ```bash
   grep -r "api/agents/subscriptions" frontend/src/
   ```
   This should return no results (all updated to `/api/subscriptions/`).

5. Verify `main.py` is under 250 lines:
   ```bash
   wc -l backend/main.py
   ```
