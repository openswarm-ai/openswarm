import asyncio
import html
import logging
import os
from uuid import uuid4

# App-level INFO logs (fast-path gates, skill recording, replay decisions) were invisible because nothing configured the 'backend' logger; every debugging session re-paid that blindness. Idempotent so uvicorn reloads don't stack handlers; uvicorn's own access logs are untouched.
p_backend_logger = logging.getLogger("backend")
if not p_backend_logger.handlers:
    p_h = logging.StreamHandler()
    p_h.setFormatter(logging.Formatter("%(asctime)s %(levelname).1s %(name)s: %(message)s", "%H:%M:%S"))
    p_backend_logger.addHandler(p_h)
    p_backend_logger.setLevel(logging.INFO)
    p_backend_logger.propagate = False

logger = logging.getLogger(__name__)

from fastapi.responses import JSONResponse, HTMLResponse
from fastapi import Request

from backend.apps.oauth_state import (
    pending_oauth,
    completed_oauth,
    MAX_COMPLETED_OAUTH,
    mark_oauth_completed,
)
from backend.config.Apps import MainApp
from backend.apps.health.health import health
from backend.apps.agents.agents import agents
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.skills.skills import skills
from backend.apps.tools_lib.tools_lib import tools_lib
from backend.apps.modes.modes import modes
from backend.apps.settings.settings import settings
from backend.apps.mcp_registry.mcp_registry import mcp_registry
from backend.apps.skill_registry.skill_registry import skill_registry
from backend.apps.outputs.outputs import outputs
from backend.apps.outputs.versions_routes import output_versions
from backend.apps.dashboards.dashboards import dashboards
from backend.apps.swarm.swarm import swarm
from backend.apps.service.service import service
from backend.apps.subscription.router import subscription
from backend.apps.auth.router import auth
from backend.apps.web.web import web
from backend.apps.agents.proxy.anthropic_proxy import anthropic_proxy
from backend.apps.agents.core.openai_passthrough import openai_passthrough
from backend.apps.workflows.workflows import workflows
from fastapi.middleware.cors import CORSMiddleware
from fastapi import WebSocket, WebSocketDisconnect
import json

main_app = MainApp([health, agents, skills, tools_lib, modes, settings, mcp_registry, skill_registry, outputs, output_versions, dashboards, swarm, service, subscription, auth, web, anthropic_proxy, workflows, openai_passthrough])
app = main_app.app

# Generate per-install auth token BEFORE we bind the HTTP port. By the time any request lands, the token file exists. See backend/auth.py.
from backend.auth import (
    init_auth_token,
    install_token_scrubber,
    is_path_exempt,
    request_matches_token,
    is_origin_allowed,
)
init_auth_token()
# Install the log scrubber AFTER the token exists so any log line that accidentally embeds it (subprocess env dumps, urllib retry traces, proxied-request error bodies) gets redacted before hitting handlers.
install_token_scrubber()

# Generate the per-install id (installation_id) at the same pre-bind moment as the auth token. It is otherwise created lazily on the first analytics submission, so on a clean install the sign-in window can render and build its Google/email OAuth URL (which embeds install_id) before that submission fires, producing an empty install_id that the cloud rejects. Generating here guarantees the very first GET /api/settings already carries it. Platform-agnostic; wrapped so a settings hiccup never blocks startup, and the lazy path stays as a fallback.
try:
    import uuid as p_uuid
    from backend.apps.settings.store import load_settings as p_load_boot_settings, save_settings as p_save_boot_settings
    p_boot_settings = p_load_boot_settings()
    if not getattr(p_boot_settings, "installation_id", None):
        p_boot_settings.installation_id = p_uuid.uuid4().hex
        p_save_boot_settings(p_boot_settings)
except Exception:
    pass


# CORS: previously wide open (`allow_origins=["*"]`), which combined with `allow_credentials=True` was a security footgun, any external origin could CORS-preflight us. Now restricted to Electron renderer origins + localhost dev servers. The token middleware below provides the *primary* defense; CORS is defense-in-depth so a misconfigured page can't even reach us.
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
    # Every cross-origin POST from the Electron renderer (file:// → http://localhost:8324) carries Authorization: Bearer, which CORS classifies as non-simple and forces a preflight OPTIONS before EACH POST. With no max_age the browser re-preflights on a tight schedule (~5 s in Chromium); under heavy interaction we observed a 1:1 OPTIONS-to-POST ratio in the dev log, doubling roundtrip count for no reason. Caching the preflight result for 10 minutes drops that to one OPTIONS per ~600 POSTs.
    max_age=600,
)


@app.middleware("http")
async def p_auth_middleware(request: Request, call_next):
    """Reject HTTP requests without our per-install bearer token.

    Exemptions (see `auth.is_path_exempt`):
      - `/api/subscriptions/callback`, external OAuth redirects
      - `/api/health`, `/api/version`, Electron boot handshake
      - `OPTIONS` preflights, browsers don't send Authorization on them

    Anything else requires `Authorization: Bearer <token>` OR
    `x-openswarm-token: <token>`. Failure responds with 401 and a short
    JSON error, no upstream handler sees the request.

    The anthropic-proxy route (`/api/anthropic-proxy/v1/*`) is NOT
    exempt. Its caller (the Claude Code CLI we spawn) is configured
    with `ANTHROPIC_API_KEY=<our_token>` so the CLI's `x-api-key`
    header carries our token, which `request_matches_token` accepts
    via its auth-header branches.
    """
    # Preflights never carry Authorization.
    if request.method == "OPTIONS":
        response = await call_next(request)
    elif is_path_exempt(request.url.path):
        response = await call_next(request)
    else:
        # Accept Authorization Bearer, x-openswarm-token, OR x-api-key (CLI path, CLI sends x-api-key with our token as value).
        headers = dict(request.headers)
        x_api_key = headers.get("x-api-key") or headers.get("X-API-Key")
        # Accept `?token=<token>` query param too. Required for browser-driven GETs that can't set headers, notably the App Builder iframe loading /api/outputs/.../serve/index.html via <iframe src="...">.
        auth_ok = request_matches_token(headers, query_params=dict(request.query_params))
        if not auth_ok and x_api_key:
            import secrets as p_s
            from backend.auth import get_auth_token as p_gt
            auth_ok = p_s.compare_digest(x_api_key, p_gt() or "\x00")
        if not auth_ok:
            logger.warning(
                f"auth: rejecting {request.method} {request.url.path} "
                f"(origin={headers.get('origin', '-')}, no valid token)"
            )
            # This middleware sits OUTSIDE CORSMiddleware, so an early 401 skips its headers and a cross-origin caller (e.g. the vite dev server) sees an opaque "CORS blocked" instead of an honest 401. Echo the origin ONLY when it matches the CORS allow-list (same regex), so the 401 is legible without re-opening CORS to arbitrary origins.
            import re as p_re
            p_origin = headers.get("origin")
            p_allowed = bool(p_origin) and bool(p_re.match(r"^(file://.*|http://localhost:\d+|http://127\.0\.0\.1:\d+|https://(api\.)?openswarm\.com)$", p_origin))
            p_cors = {"Access-Control-Allow-Origin": p_origin, "Access-Control-Allow-Credentials": "true"} if p_allowed else {}
            return JSONResponse(
                {"error": "unauthorized", "detail": "missing or invalid token"},
                status_code=401,
                headers=p_cors,
            )
        response = await call_next(request)

    # Private-Network-Access header for the one remaining public-origin path (OAuth callback). Harmless on other requests.
    response.headers.setdefault("Access-Control-Allow-Private-Network", "true")
    return response

@app.websocket("/ws/agents/{session_id}")
async def websocket_session(websocket: WebSocket, session_id: str):
    """Per-session WS endpoint with resume + heartbeat.

    Resilience contract (see backend/apps/agents/seq_log.py):
      - Every server→client event carries a monotonic `seq` per session.
      - On (re)connect the client sends `client:hello` with its
        last-seen seq; the server replays missed events (or emits
        `agent:gap_detected` if the gap is too large) and answers
        with `server:hello` carrying the current high-water seq.
      - `client:ping` → `server:pong` heartbeat (default 25s) so
        silent socket deaths (NAT idle drop, laptop sleep) are
        detected without waiting for the next outbound frame.
      - `WebSocketDisconnect` only removes the socket from the
        connection registry. The agent task keeps running. The only
        things that end a run are: natural completion, explicit
        `agent:stop`, REST `/close`, or process shutdown.
    """
    if not p_ws_auth_ok(websocket):
        return
    await ws_manager.connect_session(session_id, websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            event = msg.get("event")
            payload = msg.get("data", {})

            if event == "client:hello":
                # Resume handshake. The client sends this immediately after the WS opens, with `last_seq` = the highest seq it has applied. We replay anything newer; on first connect last_seq=0 and replay() correctly returns nothing (empty buffer) or the persisted terminal event for already-finished sessions.
                last_seq = int(payload.get("last_seq") or 0)
                connection_uuid = payload.get("connection_uuid") or ""
                ack = await ws_manager.replay_to(session_id, websocket, last_seq)
                from backend.apps.agents.core.seq_log import seq_log as p_sl
                await websocket.send_text(json.dumps({
                    "event": "server:hello",
                    "session_id": session_id,
                    "data": {
                        "connection_uuid": connection_uuid,
                        "current_seq": p_sl.current_seq(session_id),
                        "ack": ack,
                    },
                }))
            elif event == "client:ping":
                # Heartbeat. Cheap, keeps NATs/firewalls from silently dropping the connection. Carry the client's nonce back so it can match pong→ping for round-trip latency tracking if it wants.
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
        # Drops the socket from the connection list. Does NOT cancel the agent task, that's intentional. See module docstring.
        ws_manager.disconnect_session(session_id, websocket)

def p_ws_auth_ok(websocket: WebSocket) -> bool:
    """Validate token + origin before accepting a WS. Returns True if OK.

    On failure closes with 4401 (custom app-level code) and returns False,
    the caller must NOT call `websocket.accept()` or read any data.
    """
    headers = dict(websocket.headers)
    qp = dict(websocket.query_params)
    origin = headers.get("origin") or headers.get("Origin")
    token_ok = request_matches_token(headers, query_params=qp)
    origin_ok = is_origin_allowed(origin)
    if not (token_ok and origin_ok):
        reason = "bad token" if not token_ok else f"bad origin ({origin})"
        logger.warning(f"ws: rejecting connection to {websocket.url.path}, {reason}")
        # Can't `await websocket.close()` before accept(), so schedule the close in a task. The client receives a 403 on handshake.
        import asyncio as p_asyncio
        p_asyncio.create_task(websocket.close(code=4401))
        return False
    return True


@app.websocket("/ws/outputs/runtime/{workspace_id}/logs")
async def websocket_runtime_logs(websocket: WebSocket, workspace_id: str):
    """Stream the persistent app-backend's stdout/stderr to the Terminal
    pane. On connect we replay the runtime's ring buffer so a Terminal
    tab opened mid-session sees the context it missed, then we tail
    every subsequent line until disconnect."""
    if not p_ws_auth_ok(websocket):
        return
    await websocket.accept()
    from backend.apps.outputs.runtime import manager as runtime_manager
    rt = runtime_manager.get(workspace_id)
    if rt is None:
        # No active runtime, surface that to the client and close. The frontend will call /runtime/start and reconnect. Also emit a status frame with is_new_mode (computed from disk) so the preview pane shows the "starting preview…" placeholder for webapp_template workspaces instead of falling back to the legacy /serve/index.html URL (which 404s in new-mode).
        try:
            from backend.apps.outputs.outputs import runtime_status_payload
            status = runtime_status_payload(workspace_id)
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
    # Buffer log lines from the synchronous subscriber callback into an asyncio.Queue we can `await` on the WS sender side. The subscribe call replays the ring buffer synchronously, so the queue gets primed with existing lines before we enter the loop.
    queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()

    def p_on_line(line) -> None:
        try:
            queue.put_nowait((line.stream, line.text))
        except asyncio.QueueFull:
            pass

    unsubscribe = rt.subscribe(p_on_line)

    def p_build_status_frame() -> dict:
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
        # Initial status frame so the client knows port/running state without a second HTTP round-trip. `frontend_url` is the new-mode preview pointer (Vite dev server); `backend_url` is the workspace's optional FastAPI backend (old-mode backend.py OR new-mode post-backend_init.sh).
        await websocket.send_text(json.dumps(p_build_status_frame()))
        while True:
            stream, text = await queue.get()
            await websocket.send_text(json.dumps({
                "event": "runtime:log",
                "workspace_id": workspace_id,
                "data": {"stream": stream, "text": text},
            }))
            # Runtime-level events (start, frontend-ready, exit) flow through the same log channel with stream="runtime". When the client sees one, it usually wants the fresh status; bind-ready in particular flips frontend_url from null to the Vite URL and the preview pane has to know to switch over. Re-push status after every runtime line.
            if stream == "runtime":
                await websocket.send_text(json.dumps(p_build_status_frame()))
    except WebSocketDisconnect:
        pass
    finally:
        unsubscribe()


@app.websocket("/ws/dashboard")
async def websocket_dashboard(websocket: WebSocket):
    if not p_ws_auth_ok(websocket):
        return
    await ws_manager.connect_global(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            event = msg.get("event")
            payload = msg.get("data", {})
            
            if event == "client:ping":
                # No pong here meant the client heartbeat force-closed this socket every 35s, forever.
                await websocket.send_text(json.dumps({
                    "event": "server:pong",
                    "data": {"nonce": payload.get("nonce")},
                }))
            elif event == "agent:approval_response":
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
            elif event == "dashboard:active":
                dash_id = payload.get("dashboard_id")
                if dash_id:
                    ws_manager.set_active_dashboard(websocket, dash_id)
    except WebSocketDisconnect:
        ws_manager.disconnect_global(websocket)


@app.get("/api/dev/token")
async def dev_token():
    """Hand the per-install token to the dev frontend, which has no Electron
    preload to read it from. Disabled in packaged builds (the preload exists
    there); localhost binding is the only thing gating it in dev."""
    if os.environ.get("OPENSWARM_PACKAGED") == "1":
        return JSONResponse({"error": "not available"}, status_code=404)
    from backend.auth import get_auth_token
    return JSONResponse({"token": get_auth_token()})


@app.post("/api/browser/command")
async def browser_command(request: Request):
    """HTTP endpoint called by the browser MCP server subprocess.
    Proxies commands to the frontend via WebSocket and waits for results."""
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
    """Return pending OAuth data for a state param. Called by 9Router's callback page."""
    pending = pending_oauth.get(state)
    if not pending:
        return JSONResponse({"error": "not found"}, status_code=404,
                           headers={"Access-Control-Allow-Origin": "*"})
    return JSONResponse({
        "provider": pending["provider"],
        "code_verifier": pending["code_verifier"],
        "redirect_uri": pending["redirect_uri"],
    }, headers={"Access-Control-Allow-Origin": "*"})


P_SUCCESS_HTML = (
    '<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">'
    '<div style="text-align:center">'
    '<div style="width:64px;height:64px;border-radius:50%;background:#22c55e20;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;font-size:32px">&#10003;</div>'
    '<h2 style="margin:0 0 8px">Connected!</h2>'
    '<p style="color:#888;margin:0">You can close this tab, and any other login tab still open.</p>'
    '</div>'
    '<script>setTimeout(()=>window.close(),1500)</script>'
    '</body></html>'
)


@app.get("/api/subscriptions/callback")
async def subscriptions_callback(request: Request):
    """Catch OAuth redirect from provider, exchange code via 9Router, close window.

    Must be idempotent: the browser can legitimately hit this URL more than
    once (Chrome prefetch, user refresh, Google retrying a slow first
    redirect). The first call consumes `pending_oauth[state]`, so a second
    call would otherwise render a misleading "Session expired" even though
    the connection is already saved. To handle that, we track recently-
    completed state values in `completed_oauth` and return the success
    page whenever we see a duplicate.
    """
    code = request.query_params.get("code", "")
    state = request.query_params.get("state", "")
    error = request.query_params.get("error", "")

    if error:
        # Escape both inputs, `error_description` and `error` are attacker- controllable query params and the endpoint is auth-exempt, so an unescaped interpolation here is a reflected XSS in the localhost origin (loadable inside the Electron app context, where same-origin JS has access to the install token).
        desc = html.escape(request.query_params.get("error_description", error))
        return HTMLResponse(f'<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Authorization failed</h2><p style="color:#888">{desc}</p></div></body></html>')

    pending = pending_oauth.pop(state, None)
    if not pending:
        # Either a duplicate callback for a state we've already exchanged, or a truly stale state. Duplicates are the expected case: Chrome's prefetcher and some extensions speculatively GET URLs.
        if state and state in completed_oauth:
            logger.info(f"Duplicate OAuth callback for state {state[:8]}... (already completed)")
            return HTMLResponse(P_SUCCESS_HTML)
        logger.warning(f"OAuth callback with unknown state {state[:8] if state else '(empty)'}...")
        return HTMLResponse('<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Session expired</h2><p style="color:#888">Please try connecting again.</p></div></body></html>')

    from backend.apps.nine_router import exchange_oauth
    try:
        await exchange_oauth(pending["provider"], code, pending["redirect_uri"], pending["code_verifier"], state)
    except Exception as e:
        logger.warning(f"OAuth exchange failed for provider={pending.get('provider')}: {e}")
        # Escape the exception message, upstream OAuth provider errors can echo back attacker-influenced strings (e.g. error_description from the original request URL), and this response is rendered in the localhost origin.
        safe_e = html.escape(str(e))
        return HTMLResponse(f'<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Connection failed</h2><p style="color:#888">{safe_e}</p></div></body></html>')

    mark_oauth_completed(state)
    logger.info(f"OAuth exchange succeeded for provider={pending.get('provider')}")
    # A connected subscription takes precedence over the free trial right away.
    try:
        from backend.apps.subscription.free_trial import clear_free_trial_on_connect
        await clear_free_trial_on_connect()
    except Exception:
        pass
    return HTMLResponse(P_SUCCESS_HTML)


@app.post("/api/browser-agent/run")
async def browser_agent_run(request: Request):
    """Run one or more browser sub-agents in parallel.
    Called by the browser_agent_mcp_server stdio subprocess."""
    from backend.apps.settings.settings import load_settings
    from backend.apps.agents.browser.browser_agent import run_browser_agents

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
    """Back the openswarm-mcp-meta stdio MCP server.

    Actions:
      - list: enumerate installed MCPs, separated by active vs available.
      - search: rank by description match against a query.
      - activate: append to session.active_mcps + flag needs_fork=True so the
        next turn rebuilds options with the newly-activated server. Validates
        server_name against the canonical registry; unknown names return the
        valid options instead of activating (anti-hallucination).
    """
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.tools_lib.tools_lib import load_all_tools as load_all_tools, sanitize_server_name

    body = await request.json()
    parent_session_id = body.get("parent_session_id", "")

    # Aliases that broaden the search corpus for common user intents. Without these, MCPSearch("email") fails to surface Google Workspace because the tool's stored description says "Gmail" not "email". Keys are sanitized server names; values are extra search-hint tokens appended to the haystack. Only generic synonyms, anything that's already in the description doesn't need to be listed.
    P_SERVER_SEARCH_ALIASES: dict[str, list[str]] = {
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

    def p_connected_servers() -> list[dict]:
        out = []
        for t in load_all_tools():
            if not (t.mcp_config and t.enabled and t.auth_status in ("configured", "connected")):
                continue
            sanitized = sanitize_server_name(t.name)
            # Pull tool sub-action names from tool_permissions._tool_descriptions so MCPSearch can match against capability names (e.g. "send_email").
            action_names: list[str] = []
            try:
                td = (t.tool_permissions or {}).get("_tool_descriptions", {})
                if isinstance(td, dict):
                    action_names = [str(k) for k in td.keys() if not str(k).startswith("_")]
            except Exception:
                pass
            aliases = P_SERVER_SEARCH_ALIASES.get(sanitized, [])
            out.append({
                "name": sanitized,
                "description": (t.description or "").strip() or f"{t.name} integration",
                "raw_name": t.name,
                "_search_extras": " ".join(action_names + aliases),
            })
        return out

    def p_strip_extras(s: dict) -> dict:
        return {k: v for k, v in s.items() if not k.startswith("_")}

    if action == "list":
        servers = p_connected_servers()
        session = agent_manager.sessions.get(parent_session_id) if parent_session_id else None
        active_set = set(session.active_mcps) if session else set()
        active = [{**p_strip_extras(s), "status": "active"} for s in servers if s["name"] in active_set]
        available = [{**p_strip_extras(s), "status": "available"} for s in servers if s["name"] not in active_set]
        return JSONResponse({"active": active, "available": available})

    if action == "search":
        query = (body.get("query") or "").strip().lower()
        servers = p_connected_servers()
        session = agent_manager.sessions.get(parent_session_id) if parent_session_id else None
        active_set = set(session.active_mcps) if session else set()
        # Ranking: substring hits across name+description+sub-tool names+ generic-purpose aliases. The aliases are what let "email" match google-workspace even though the description says "Gmail". Active-first tiebreak so the model prefers servers it has already activated when both score equally.
        scored: list[tuple[int, dict]] = []
        for s in servers:
            extras = s.get("_search_extras", "")
            hay = f"{s['name']} {s['raw_name']} {s['description']} {extras}".lower()
            score = 0
            for tok in query.split():
                if tok and tok in hay:
                    # Hits in the canonical name count more; alias hits count once so a "drive" query doesn't beat the actual Drive tool description.
                    if tok in s["name"]:
                        score += 2
                    elif tok in s["description"].lower():
                        score += 2
                    else:
                        score += 1
            if score:
                annotated = {**p_strip_extras(s), "status": "active" if s["name"] in active_set else "available"}
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

        servers = p_connected_servers()
        valid_names = {s["name"] for s in servers}
        if server_name not in valid_names:
            return JSONResponse({"status": "unknown_server", "available": sorted(valid_names)})

        if server_name in session.active_mcps:
            return JSONResponse({"status": "already_active", "server_name": server_name})

        session.active_mcps.append(server_name)
        session.needs_fork = True
        try:
            from backend.apps.agents.core.ws_manager import ws_manager as p_ws
            await p_ws.send_to_session(parent_session_id, "agent:status", {
                "session_id": parent_session_id,
                "status": session.status,
                "session": session.model_dump(mode="json"),
            })
        except Exception:
            logger.exception("Failed to broadcast post-activate session status")
        pass  # MCP activation captured via session dump on close

        # Auto-continue: flag the session so that after its current turn ends (which is the turn that contains this MCPActivate tool call), the agent loop dispatches a synthetic "continue" turn with the freshly-activated tools available. Race-free, read at the natural turn-boundary inside _run_agent_loop instead of racing a background task against the turn's completion path. Turns the typical 3-prompt flow ("check email" → MCPActivate → "do it") into a 1-prompt flow.
        session.pending_continuation = True
        # Enumerate the just-activated server's callable tool names so the continuation turn can call them directly. Without this the model often burns a turn on tool-discovery guesses (Bash "mcp list", Ls /toolbox, ToolSearch fallbacks) before landing on the right mcp__server__action name. Cap at 16 + clip descriptions so the prompt stays bounded for kitchen-sink servers (google-workspace exposes ~30 tools). Best-effort; any lookup failure silently falls back to the same prompt this code shipped with before.
        tool_hint = ""
        try:
            for t in load_all_tools():
                if sanitize_server_name(t.name) != server_name:
                    continue
                descs = (t.tool_permissions or {}).get("_tool_descriptions", {}) or {}
                if not descs:
                    break
                lines: list[str] = []
                for sub_name, desc in list(descs.items())[:16]:
                    short = (desc or "").strip().split("\n", 1)[0][:120]
                    visible = f"mcp__{server_name}__{sub_name}"
                    lines.append(f"- `{visible}`: {short}" if short else f"- `{visible}`")
                if lines:
                    more = "" if len(descs) <= 16 else f"\n(+ {len(descs) - 16} more; call ToolSearch with the server name for the rest)"
                    tool_hint = "\n\nCallable tools on this server:\n" + "\n".join(lines) + more
                break
        except Exception:
            logger.exception("activate: failed to build tool hint for %s", server_name)
        session.pending_continuation_prompt = (
            "[mcp:auto-continue] The MCP server you requested has been "
            f"activated (`{server_name}`). Continue with the user's original "
            "request now using the newly-available tools; do NOT ask "
            "for confirmation." + tool_hint
        )

        return JSONResponse({"status": "activated", "server_name": server_name, "auto_continue": True})

    return JSONResponse({"error": f"unknown action: {action}"}, status_code=400)


@app.post("/api/settings-meta/{action}")
async def settings_meta(action: str, request: Request):
    """Back the openswarm-settings-meta stdio MCP server (agent-editable Settings).

    Actions:
      - read: the full settings object with every secret redacted to
        configured/not (never the value), so an always-on read is never an
        exfiltration path.
      - write: apply a field -> value map. Three things can't be written, in
        priority order: an unknown field (reported, not invented), a server-owned
        subscription/connection field (managed by its dedicated flow), and the
        credential powering THIS run (the no-suicide rule, enforced structurally
        via resolve_powering_credential). Everything else is applied through the
        same path PUT /api/settings uses, so 9router reconciliation and the
        server-owned restore behave identically.
    """
    from backend.apps.settings.store import load_settings
    from backend.apps.settings.models import AppSettings
    from backend.apps.settings.redaction import redact_settings
    from backend.apps.settings.settings import SERVER_OWNED_FIELDS, apply_settings_update, settings_write_lock
    from backend.apps.agents.session_credential import (
        ALL_API_KEY_FIELDS, PoweringCredential, resolve_powering_credential, write_would_suicide,
    )
    from backend.apps.agents.agent_manager import agent_manager
    from pydantic import ValidationError

    body = await request.json()
    parent_session_id = body.get("parent_session_id", "")

    if action == "read":
        return JSONResponse({"settings": redact_settings(load_settings().model_dump())})

    if action == "write":
        changes = body.get("changes")
        if not isinstance(changes, dict) or not changes:
            return JSONResponse({"error": "changes must be a non-empty object of field -> value"}, status_code=400)

        valid_fields = set(AppSettings.model_fields.keys())
        outcomes: dict[str, dict] = {}
        # Serialize the read-modify-write: SettingsWrite goes through apply_settings_update, which awaits (so two autonomous agents would interleave and clobber each other's fields while BOTH got an "applied" result). The lock makes agent writes serial so the last load always sees the prior write. (Agent vs the renderer's own PUT stays the pre-existing full-object-replace race.)
        async with settings_write_lock():
            settings = load_settings()
            session = agent_manager.sessions.get(parent_session_id) if parent_session_id else None
            if session is not None:
                powering = resolve_powering_credential(session.model, settings)
            else:
                # No live session to anchor the guard: fail safe, protect every credential.
                powering = PoweringCredential(kind="unknown", provider="unknown", label="this run")

            # The credential field(s) the second-wall restore in apply_settings_update must never let a write blank (independent of the per-field guard below).
            if powering.kind == "unknown":
                protect_fields = set(ALL_API_KEY_FIELDS)
            elif powering.kind == "api_key" and powering.protected_field:
                protect_fields = {powering.protected_field}
            else:
                protect_fields = set()

            staged: dict = {}
            for field, value in changes.items():
                if field not in valid_fields:
                    outcomes[field] = {"status": "unknown", "reason": "not a settings field"}
                elif field in SERVER_OWNED_FIELDS:
                    outcomes[field] = {"status": "refused", "reason": "managed by your subscription/connection; change it in the Subscription section"}
                elif write_would_suicide(field, value, powering):
                    outcomes[field] = {"status": "refused", "reason": f"would disconnect {powering.label}, which is powering this run"}
                else:
                    staged[field] = value

            if staged:
                merged = settings.model_dump()
                merged.update(staged)
                try:
                    new_body = AppSettings(**merged)
                except ValidationError as e:
                    bad = {str(err["loc"][0]) for err in e.errors() if err.get("loc")}
                    for f in bad & set(staged.keys()):
                        outcomes[f] = {"status": "refused", "reason": "invalid value for this field"}
                        staged.pop(f, None)
                    new_body = None
                    if staged:
                        merged = settings.model_dump()
                        merged.update(staged)
                        new_body = AppSettings(**merged)
                if staged and new_body is not None:
                    try:
                        await apply_settings_update(new_body, protect_fields=protect_fields)
                        for f in staged:
                            outcomes[f] = {"status": "applied"}
                    except Exception as e:
                        # Don't hand the agent an opaque 500; tell it which writes failed.
                        for f in staged:
                            outcomes[f] = {"status": "error", "reason": f"write failed: {e}"}

        if any(o.get("status") == "applied" for o in outcomes.values()):
            # An agent wrote settings (not the user via the modal), so nudge every open window to refetch instead of waiting for the next window-focus. Pure signal: the renderer refetches the authoritative state, so nothing (least of all a secret) needs to ride the broadcast.
            from backend.apps.agents.core.ws_manager import ws_manager as p_wsm
            await p_wsm.broadcast_global("settings:changed", {})

        return JSONResponse({"outcomes": outcomes})

    return JSONResponse({"error": f"unknown action: {action}"}, status_code=400)


@app.post("/api/agents/sessions/{session_id}/compact")
async def session_compact(session_id: str):
    """Force a compaction pass on a session (Phase 2 /compact slash cmd).

    User explicitly clicked compact, so we accept the prompt-cache loss in exchange
    for a real visible trim: needs_fresh_session drops the SDK convo so the next turn
    rebuilds from history with compacted_through_msg_id actually applied (auto-compact
    only sets the marker; the button is the user opting into the cost).
    """
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.core.ws_manager import ws_manager as p_ws
    session = agent_manager.sessions.get(session_id)
    if not session:
        return JSONResponse({"error": "session not found"}, status_code=404)
    did_compact = agent_manager.maybe_compact(session, force=True)
    if did_compact:
        session.needs_fresh_session = True
    await p_ws.send_to_session(session_id, "agent:context_status", {
        "session_id": session_id,
        "reason": "compacted_manual" if did_compact else "noop",
        "compacted_through_msg_id": session.compacted_through_msg_id,
    })
    return JSONResponse({"compacted": did_compact, "compacted_through_msg_id": session.compacted_through_msg_id})


@app.post("/api/agents/sessions/{session_id}/clear")
async def session_clear(session_id: str):
    """Wipe the session's UI history AND its SDK convo state (/clear slash cmd, Reset history button)."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.core.ws_manager import ws_manager as p_ws
    from backend.apps.agents.core.models import MessageBranch
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
    await p_ws.send_to_session(session_id, "agent:status", {
        "session_id": session_id,
        "status": session.status,
        "session": session.model_dump(mode="json"),
    })
    await p_ws.send_to_session(session_id, "agent:context_status", {
        "session_id": session_id,
        "reason": "cleared",
    })
    return JSONResponse({"cleared": True})


@app.post("/api/invoke-agent/run")
async def invoke_agent_run(request: Request):
    """Fork an existing agent session and send it a new message.
    Called by the invoke_agent_mcp_server stdio subprocess."""
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

    class p_ReadyServer(uvicorn.Server):
        """Subclass that prints a machine-readable READY line on startup."""
        async def startup(self, sockets=None):
            await super().startup(sockets)
            print(f"READY:PORT={args.port}", flush=True)

    if args.reload:
        uvicorn.run("backend.main:app", host=args.host, port=args.port, reload=True)
    else:
        config = uvicorn.Config("backend.main:app", host=args.host, port=args.port)
        server = p_ReadyServer(config)
        import asyncio
        asyncio.run(server.serve())
