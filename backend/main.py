import asyncio
import html
import logging
import os
from uuid import uuid4

logger = logging.getLogger(__name__)

from fastapi.responses import JSONResponse, HTMLResponse
from fastapi import Request

_pending_oauth: dict[str, dict] = {}
# Bounded FIFO of recently-completed OAuth states; lets the callback distinguish duplicate hits (prefetch, refresh) from stale.
_completed_oauth: list[str] = []
_MAX_COMPLETED_OAUTH = 64


def _mark_oauth_completed(state: str) -> None:
    if state in _completed_oauth:
        return
    _completed_oauth.append(state)
    while len(_completed_oauth) > _MAX_COMPLETED_OAUTH:
        _completed_oauth.pop(0)
from backend.config.Apps import MainApp
from backend.apps.health.health import health
from backend.apps.agents.agents import agents
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.skills.skills import skills
from backend.apps.tools_lib.tools_lib import tools_lib
from backend.apps.modes.modes import modes
from backend.apps.settings.settings import settings
from backend.apps.mcp_registry.mcp_registry import mcp_registry
from backend.apps.skill_registry.skill_registry import skill_registry
from backend.apps.outputs.outputs import outputs
from backend.apps.dashboards.dashboards import dashboards
from backend.apps.service.service import service
from backend.apps.subscription.router import subscription
from backend.apps.auth.router import auth
from backend.apps.web.web import web
from backend.apps.agents.anthropic_proxy import anthropic_proxy
from backend.apps.workflows.workflows import workflows
from fastapi.middleware.cors import CORSMiddleware
from fastapi import WebSocket, WebSocketDisconnect
import json

main_app = MainApp([health, agents, skills, tools_lib, modes, settings, mcp_registry, skill_registry, outputs, dashboards, service, subscription, auth, web, anthropic_proxy, workflows])
app = main_app.app

# Generate per-install auth token BEFORE we bind the HTTP port so the token file exists by the time any request lands.
from backend.auth import (
    init_auth_token,
    install_token_scrubber,
    is_path_exempt,
    request_matches_token,
    is_origin_allowed,
)
init_auth_token()
# Install log scrubber AFTER token exists so any log line embedding it gets redacted before handlers see it.
install_token_scrubber()


# CORS restricted to Electron renderer + localhost dev; token middleware below is the primary defense.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://api.openswarm.com",
        "https://openswarm.com",
    ],
    allow_origin_regex=r"^(file://.*|http://localhost:\d+|http://127\.0\.0\.1:\d+)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Cache preflight 10min; without this Chromium re-preflights every ~5s and we saw 1:1 OPTIONS:POST in dev logs.
    max_age=600,
)


@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    """Reject HTTP requests without our per-install bearer token."""
    if request.method == "OPTIONS":
        response = await call_next(request)
    elif is_path_exempt(request.url.path):
        response = await call_next(request)
    else:
        headers = dict(request.headers)
        x_api_key = headers.get("x-api-key") or headers.get("X-API-Key")
        # Accept ?token= for browser-driven GETs that can't set headers (App Builder iframe).
        auth_ok = request_matches_token(headers, query_params=dict(request.query_params))
        if not auth_ok and x_api_key:
            import secrets as _s
            from backend.auth import get_auth_token as _gt
            auth_ok = _s.compare_digest(x_api_key, _gt() or "\x00")
        if not auth_ok:
            logger.warning(
                f"auth: rejecting {request.method} {request.url.path} "
                f"(origin={headers.get('origin', '-')}, no valid token)"
            )
            return JSONResponse(
                {"error": "unauthorized", "detail": "missing or invalid token"},
                status_code=401,
            )
        response = await call_next(request)

    # PNA header for the OAuth callback (one remaining public-origin path); harmless elsewhere.
    response.headers.setdefault("Access-Control-Allow-Private-Network", "true")
    return response

@app.websocket("/ws/agents/{session_id}")
async def websocket_session(websocket: WebSocket, session_id: str):
    """Per-session WS endpoint with resume + heartbeat (see seq_log.py for the contract)."""
    if not _ws_auth_ok(websocket):
        return
    await ws_manager.connect_session(session_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            event = msg.get("event")
            payload = msg.get("data", {})

            if event == "client:hello":
                last_seq = int(payload.get("last_seq") or 0)
                connection_uuid = payload.get("connection_uuid") or ""
                ack = await ws_manager.replay_to(session_id, websocket, last_seq)
                from backend.apps.agents.seq_log import seq_log as _sl
                await websocket.send_text(json.dumps({
                    "event": "server:hello",
                    "session_id": session_id,
                    "data": {
                        "connection_uuid": connection_uuid,
                        "current_seq": _sl.current_seq(session_id),
                        "ack": ack,
                    },
                }))
            elif event == "client:ping":
                await websocket.send_text(json.dumps({
                    "event": "server:pong",
                    "session_id": session_id,
                    "data": {"nonce": payload.get("nonce")},
                }))
            elif event == "agent:send_message":
                from backend.apps.agents.agent_manager import agent_manager
                await agent_manager.send_message(
                    session_id,
                    payload.get("prompt", ""),
                    mode=payload.get("mode"),
                    model=payload.get("model"),
                    provider=payload.get("provider"),
                    images=payload.get("images"),
                )
            elif event == "agent:approval_response":
                from backend.apps.agents.agent_manager import agent_manager
                agent_manager.handle_approval(payload.get("request_id"), {
                    "behavior": payload.get("behavior", "deny"),
                    "message": payload.get("message"),
                    "updated_input": payload.get("updated_input"),
                    "trust_pattern": bool(payload.get("trust_pattern")),
                })
            elif event == "agent:edit_message":
                from backend.apps.agents.agent_manager import agent_manager
                await agent_manager.edit_message(
                    session_id,
                    payload.get("message_id", ""),
                    payload.get("content", ""),
                )
            elif event == "agent:stop":
                from backend.apps.agents.agent_manager import agent_manager
                await agent_manager.stop_agent(session_id)
    except WebSocketDisconnect:
        # Drops the socket but does NOT cancel the agent task; that's intentional.
        ws_manager.disconnect_session(session_id, websocket)

def _ws_auth_ok(websocket: WebSocket) -> bool:
    """Validate token + origin before accepting a WS; closes with 4401 on failure."""
    headers = dict(websocket.headers)
    qp = dict(websocket.query_params)
    origin = headers.get("origin") or headers.get("Origin")
    token_ok = request_matches_token(headers, query_params=qp)
    origin_ok = is_origin_allowed(origin)
    if not (token_ok and origin_ok):
        reason = "bad token" if not token_ok else f"bad origin ({origin})"
        logger.warning(f"ws: rejecting connection to {websocket.url.path}: {reason}")
        # Can't await close() before accept(); schedule it so the client sees a 403 on handshake.
        import asyncio as _asyncio
        _asyncio.create_task(websocket.close(code=4401))
        return False
    return True


@app.websocket("/ws/outputs/runtime/{workspace_id}/logs")
async def websocket_runtime_logs(websocket: WebSocket, workspace_id: str):
    """Stream the app-backend's stdout/stderr to the Terminal pane; replays ring buffer on connect, tails after."""
    if not _ws_auth_ok(websocket):
        return
    await websocket.accept()
    from backend.apps.outputs.runtime import manager as runtime_manager
    rt = runtime_manager.get(workspace_id)
    if rt is None:
        # No runtime: emit is_new_mode status so webapp_template workspaces show the starting-preview placeholder, not the legacy 404ing serve URL.
        try:
            from backend.apps.outputs.outputs import _runtime_status_payload
            status = _runtime_status_payload(workspace_id)
            await websocket.send_text(json.dumps({
                "event": "runtime:status",
                "workspace_id": workspace_id,
                "data": status,
            }))
            await websocket.send_text(json.dumps({
                "event": "runtime:not_attached",
                "workspace_id": workspace_id,
            }))
        finally:
            await websocket.close()
        return
    # Bridge sync subscriber callback to async sender; subscribe replays the ring buffer synchronously, priming the queue.
    queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()

    def _on_line(line) -> None:
        try:
            queue.put_nowait((line.stream, line.text))
        except asyncio.QueueFull:
            pass

    unsubscribe = rt.subscribe(_on_line)

    def _build_status_frame() -> dict:
        return {
            "event": "runtime:status",
            "workspace_id": workspace_id,
            "data": {
                "running": rt.running,
                "port": rt.port,
                "backend_url": f"http://127.0.0.1:{rt.port}" if rt.running and rt.port else None,
                "frontend_port": rt.frontend_port,
                "frontend_url": rt.frontend_url if rt.running else None,
                "is_new_mode": rt.is_new_mode,
            },
        }

    try:
        await websocket.send_text(json.dumps(_build_status_frame()))
        while True:
            stream, text = await queue.get()
            await websocket.send_text(json.dumps({
                "event": "runtime:log",
                "workspace_id": workspace_id,
                "data": {"stream": stream, "text": text},
            }))
            # Re-push status on runtime events: bind-ready flips frontend_url from null to the Vite URL and the preview pane needs to switch.
            if stream == "runtime":
                await websocket.send_text(json.dumps(_build_status_frame()))
    except WebSocketDisconnect:
        pass
    finally:
        unsubscribe()


@app.websocket("/ws/dashboard")
async def websocket_dashboard(websocket: WebSocket):
    if not _ws_auth_ok(websocket):
        return
    await ws_manager.connect_global(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            event = msg.get("event")
            payload = msg.get("data", {})
            
            if event == "agent:approval_response":
                from backend.apps.agents.agent_manager import agent_manager
                agent_manager.handle_approval(payload.get("request_id"), {
                    "behavior": payload.get("behavior", "deny"),
                    "message": payload.get("message"),
                    "updated_input": payload.get("updated_input"),
                    "trust_pattern": bool(payload.get("trust_pattern")),
                })
            elif event == "browser:result":
                ws_manager.resolve_browser_command(
                    payload.get("request_id", ""),
                    payload,
                )
    except WebSocketDisconnect:
        ws_manager.disconnect_global(websocket)


@app.post("/api/browser/command")
async def browser_command(request: Request):
    """Browser MCP subprocess endpoint; proxies commands to frontend over WS and waits for results."""
    body = await request.json()
    action = body.get("action", "")
    browser_id = body.get("browser_id", "")
    tab_id = body.get("tab_id", "")
    params = body.get("params", {})

    if not action or not browser_id:
        return JSONResponse({"error": "action and browser_id are required"}, status_code=400)

    request_id = uuid4().hex
    result = await ws_manager.send_browser_command(request_id, action, browser_id, params, tab_id=tab_id)
    return JSONResponse(result)


@app.get("/api/subscriptions/pending/{state}")
async def subscriptions_pending(state: str):
    """Return pending OAuth data for a state param; called by 9Router's callback page."""
    pending = _pending_oauth.get(state)
    if not pending:
        return JSONResponse({"error": "not found"}, status_code=404,
                           headers={"Access-Control-Allow-Origin": "*"})
    return JSONResponse({
        "provider": pending["provider"],
        "code_verifier": pending["code_verifier"],
        "redirect_uri": pending["redirect_uri"],
    }, headers={"Access-Control-Allow-Origin": "*"})


_SUCCESS_HTML = (
    '<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">'
    '<div style="text-align:center">'
    '<div style="width:64px;height:64px;border-radius:50%;background:#22c55e20;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:32px">&#10003;</div>'
    '<h2 style="margin:0 0 8px">Connected!</h2>'
    '<p style="color:#888;margin:0">You can close this window</p>'
    '</div>'
    '<script>setTimeout(()=>window.close(),1500)</script>'
    '</body></html>'
)


@app.get("/api/subscriptions/callback")
async def subscriptions_callback(request: Request):
    """Catch OAuth redirect from provider, exchange code via 9Router, close window; idempotent against prefetch/refresh duplicates."""
    code = request.query_params.get("code", "")
    state = request.query_params.get("state", "")
    error = request.query_params.get("error", "")

    if error:
        # Escape: error/error_description are attacker-controllable and this endpoint is auth-exempt, so raw interpolation is reflected XSS in the localhost origin.
        desc = html.escape(request.query_params.get("error_description", error))
        return HTMLResponse(f'<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Authorization failed</h2><p style="color:#888">{desc}</p></div></body></html>')

    pending = _pending_oauth.pop(state, None)
    if not pending:
        if state and state in _completed_oauth:
            logger.info(f"Duplicate OAuth callback for state {state[:8]}... (already completed)")
            return HTMLResponse(_SUCCESS_HTML)
        logger.warning(f"OAuth callback with unknown state {state[:8] if state else '(empty)'}...")
        return HTMLResponse('<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Session expired</h2><p style="color:#888">Please try connecting again.</p></div></body></html>')

    from backend.apps.nine_router import exchange_oauth
    try:
        await exchange_oauth(pending["provider"], code, pending["redirect_uri"], pending["code_verifier"], state)
    except Exception as e:
        logger.warning(f"OAuth exchange failed for provider={pending.get('provider')}: {e}")
        # Escape: upstream OAuth errors can echo attacker-influenced strings and this response renders in the localhost origin.
        safe_e = html.escape(str(e))
        return HTMLResponse(f'<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Connection failed</h2><p style="color:#888">{safe_e}</p></div></body></html>')

    _mark_oauth_completed(state)
    logger.info(f"OAuth exchange succeeded for provider={pending.get('provider')}")
    return HTMLResponse(_SUCCESS_HTML)


@app.post("/api/browser-agent/run")
async def browser_agent_run(request: Request):
    """Run one or more browser sub-agents in parallel; called by the browser_agent_mcp_server stdio subprocess."""
    from backend.apps.settings.settings import load_settings
    from backend.apps.agents.browser_agent import run_browser_agents

    body = await request.json()
    tasks = body.get("tasks", [])
    model = body.get("model", "sonnet")
    dashboard_id = body.get("dashboard_id", "")
    pre_selected_browser_ids = body.get("pre_selected_browser_ids", [])
    parent_session_id = body.get("parent_session_id", "")

    if not tasks:
        return JSONResponse({"error": "tasks array is required"}, status_code=400)

    results = await run_browser_agents(
        tasks=tasks,
        model=model,
        dashboard_id=dashboard_id or None,
        pre_selected_browser_ids=pre_selected_browser_ids,
        parent_session_id=parent_session_id or None,
    )
    return JSONResponse({"results": results})


@app.post("/api/mcp-meta/{action}")
async def mcp_meta(action: str, request: Request):
    """Back the openswarm-mcp-meta stdio MCP server: list, search, activate."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.tools_lib.tools_lib import _load_all as load_all_tools, _sanitize_server_name

    body = await request.json()
    parent_session_id = body.get("parent_session_id", "")

    # Synonym aliases broaden the search corpus so MCPSearch("email") surfaces Google Workspace despite its description saying "Gmail".
    _SERVER_SEARCH_ALIASES: dict[str, list[str]] = {
        "google-workspace": [
            "email", "inbox", "mail", "gmail", "calendar", "schedule",
            "events", "drive", "docs", "sheets", "spreadsheet", "slides",
            "presentation",
        ],
        "microsoft-365": [
            "email", "inbox", "mail", "outlook", "calendar", "schedule",
            "onedrive", "excel", "spreadsheet", "onenote", "teams",
            "sharepoint", "tasks", "contacts",
        ],
        "discord": ["chat", "message", "messaging", "server", "guild", "voice"],
        "slack": ["chat", "message", "messaging", "dm", "thread", "workspace"],
        "notion": ["docs", "wiki", "notes", "knowledge base", "database", "pages"],
        "airtable": ["spreadsheet", "database", "table", "records"],
        "hubspot": ["crm", "sales", "leads", "contacts", "deals"],
        "reddit": ["forum", "subreddit", "posts", "comments", "social"],
        "youtube": ["video", "transcript", "channel"],
    }

    def _connected_servers() -> list[dict]:
        out = []
        for t in load_all_tools():
            if not (t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")):
                continue
            sanitized = _sanitize_server_name(t.name)
            # Pull sub-action names so MCPSearch can match against capability names like "send_email".
            action_names: list[str] = []
            try:
                td = (t.tool_permissions or {}).get("_tool_descriptions", {})
                if isinstance(td, dict):
                    action_names = [str(k) for k in td.keys() if not str(k).startswith("_")]
            except Exception:
                pass
            aliases = _SERVER_SEARCH_ALIASES.get(sanitized, [])
            out.append({
                "name": sanitized,
                "description": (t.description or "").strip() or f"{t.name} integration",
                "raw_name": t.name,
                "_search_extras": " ".join(action_names + aliases),
            })
        return out

    def _strip_extras(s: dict) -> dict:
        return {k: v for k, v in s.items() if not k.startswith("_")}

    if action == "list":
        servers = _connected_servers()
        session = agent_manager.sessions.get(parent_session_id) if parent_session_id else None
        active_set = set(session.active_mcps) if session else set()
        active = [{**_strip_extras(s), "status": "active"} for s in servers if s["name"] in active_set]
        available = [{**_strip_extras(s), "status": "available"} for s in servers if s["name"] not in active_set]
        return JSONResponse({"active": active, "available": available})

    if action == "search":
        query = (body.get("query") or "").strip().lower()
        servers = _connected_servers()
        session = agent_manager.sessions.get(parent_session_id) if parent_session_id else None
        active_set = set(session.active_mcps) if session else set()
        # Substring rank across name+desc+sub-tools+aliases; active-first tiebreak.
        scored: list[tuple[int, dict]] = []
        for s in servers:
            extras = s.get("_search_extras", "")
            hay = f"{s['name']} {s['raw_name']} {s['description']} {extras}".lower()
            score = 0
            for tok in query.split():
                if tok and tok in hay:
                    # Canonical name hits weight 2; alias hits 1 so "drive" doesn't beat the actual Drive description.
                    if tok in s["name"]:
                        score += 2
                    elif tok in s["description"].lower():
                        score += 2
                    else:
                        score += 1
            if score:
                annotated = {**_strip_extras(s), "status": "active" if s["name"] in active_set else "available"}
                scored.append((score, annotated))
        scored.sort(key=lambda t: (-t[0], 0 if t[1]["status"] == "active" else 1, t[1]["name"]))
        matches = [s for _, s in scored[:5]]
        return JSONResponse({"matches": matches})

    if action == "activate":
        server_name = (body.get("server_name") or "").strip()
        reason = body.get("reason") or ""
        if not server_name:
            return JSONResponse({"error": "server_name is required"}, status_code=400)
        if not parent_session_id:
            return JSONResponse({"error": "parent_session_id is required"}, status_code=400)
        session = agent_manager.sessions.get(parent_session_id)
        if not session:
            return JSONResponse({"error": "session not found"}, status_code=404)

        servers = _connected_servers()
        valid_names = {s["name"] for s in servers}
        if server_name not in valid_names:
            return JSONResponse({"status": "unknown_server", "available": sorted(valid_names)})

        if server_name in session.active_mcps:
            return JSONResponse({"status": "already_active", "server_name": server_name})

        session.active_mcps.append(server_name)
        session.needs_fork = True
        # Mid-session activations need a fresh-session restart: the CLI snapshots mcp_servers at launch, so fork_session alone won't re-read schemas.
        if session.sdk_session_id:
            session.needs_fresh_session = True
        try:
            from backend.apps.agents.ws_manager import ws_manager as _ws
            await _ws.send_to_session(parent_session_id, "agent:status", {
                "session_id": parent_session_id,
                "status": session.status,
                "session": session.model_dump(mode="json"),
            })
        except Exception:
            logger.exception("Failed to broadcast post-activate session status")

        # Auto-continue: read at turn boundary in _run_agent_loop (race-free); collapses the typical 3-prompt flow into 1.
        session.pending_continuation = True
        session.pending_continuation_prompt = (
            "[mcp:auto-continue] The MCP server you requested has been "
            f"activated (`{server_name}`). Continue with the user's original "
            "request now using the newly-available tools; do NOT ask "
            "for confirmation."
        )

        return JSONResponse({"status": "activated", "server_name": server_name, "auto_continue": True})

    return JSONResponse({"error": f"unknown action: {action}"}, status_code=400)


@app.post("/api/agents/sessions/{session_id}/compact")
async def session_compact(session_id: str):
    """Force a compaction pass on a session (/compact slash cmd); programmatic summary, no aux LLM call."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.ws_manager import ws_manager as _ws
    session = agent_manager.sessions.get(session_id)
    if not session:
        return JSONResponse({"error": "session not found"}, status_code=404)
    did_compact = agent_manager._maybe_compact(session, force=True)
    session.needs_fork = True
    await _ws.send_to_session(session_id, "agent:context_status", {
        "session_id": session_id,
        "reason": "compacted_manual" if did_compact else "noop",
        "compacted_through_msg_id": session.compacted_through_msg_id,
    })
    return JSONResponse({"compacted": did_compact, "compacted_through_msg_id": session.compacted_through_msg_id})


@app.post("/api/agents/sessions/{session_id}/clear")
async def session_clear(session_id: str):
    """Wipe the session's UI history AND its SDK convo state (/clear slash cmd, Reset history button)."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.ws_manager import ws_manager as _ws
    from backend.apps.agents.models import MessageBranch
    session = agent_manager.sessions.get(session_id)
    if not session:
        return JSONResponse({"error": "session not found"}, status_code=404)
    session.sdk_session_id = None
    session.active_mcps = []
    session.compacted_through_msg_id = None
    session.tokens = {"input": 0, "output": 0}
    session.cost_usd = 0.0
    session.needs_fork = False
    session.messages = []
    session.pending_approvals = []
    session.branches = {"main": MessageBranch(id="main")}
    session.active_branch_id = "main"
    session.tool_group_meta = {}
    await _ws.send_to_session(session_id, "agent:status", {
        "session_id": session_id,
        "status": session.status,
        "session": session.model_dump(mode="json"),
    })
    await _ws.send_to_session(session_id, "agent:context_status", {
        "session_id": session_id,
        "reason": "cleared",
    })
    return JSONResponse({"cleared": True})


@app.post("/api/invoke-agent/run")
async def invoke_agent_run(request: Request):
    """Fork an existing agent session and send a new message; called by invoke_agent_mcp_server."""
    body = await request.json()
    session_id = body.get("session_id", "")
    message = body.get("message", "")
    parent_session_id = body.get("parent_session_id", "")
    dashboard_id = body.get("dashboard_id", "")

    if not session_id:
        return JSONResponse({"error": "session_id is required"}, status_code=400)
    if not message:
        return JSONResponse({"error": "message is required"}, status_code=400)

    try:
        from backend.apps.agents.agent_manager import agent_manager
        result = await agent_manager.invoke_agent(
            source_session_id=session_id,
            message=message,
            parent_session_id=parent_session_id or None,
            dashboard_id=dashboard_id or None,
        )
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=404)
    except Exception as e:
        logger.exception("invoke_agent_run failed")
        return JSONResponse({"error": str(e)}, status_code=500)


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="OpenSwarm backend server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("OPENSWARM_PORT", "8324")))
    parser.add_argument("--host", default=os.environ.get("OPENSWARM_HOST", "127.0.0.1"))
    parser.add_argument("--reload", action="store_true", default=False)
    args = parser.parse_args()

    os.environ["OPENSWARM_PORT"] = str(args.port)

    import uvicorn.config

    class _ReadyServer(uvicorn.Server):
        """Prints a machine-readable READY line on startup."""
        async def startup(self, sockets=None):
            await super().startup(sockets)
            print(f"READY:PORT={args.port}", flush=True)

    if args.reload:
        uvicorn.run("backend.main:app", host=args.host, port=args.port, reload=True)
    else:
        config = uvicorn.Config("backend.main:app", host=args.host, port=args.port)
        server = _ReadyServer(config)
        import asyncio
        asyncio.run(server.serve())
