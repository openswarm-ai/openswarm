import logging
import os
from uuid import uuid4

logger = logging.getLogger(__name__)

from fastapi.responses import JSONResponse, HTMLResponse
from fastapi import Request

# In-memory store for pending OAuth flows (state -> {provider, code_verifier, redirect_uri})
_pending_oauth: dict[str, dict] = {}
# Recently-completed OAuth states so the /api/subscriptions/callback handler
# can distinguish a legitimate duplicate callback (browser prefetch, refresh,
# or Google redirect retry after a slow first response) from a truly stale
# request. Bounded FIFO — drops the oldest entries once it grows past
# _MAX_COMPLETED_OAUTH so it can't leak memory.
_completed_oauth: list[str] = []
_MAX_COMPLETED_OAUTH = 64


def _mark_oauth_completed(state: str) -> None:
    if state in _completed_oauth:
        return
    _completed_oauth.append(state)
    # Trim head if we've outgrown the bound
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
from backend.apps.web.web import web
from backend.apps.agents.anthropic_proxy import anthropic_proxy
from fastapi.middleware.cors import CORSMiddleware
from fastapi import WebSocket, WebSocketDisconnect
import json

main_app = MainApp([health, agents, skills, tools_lib, modes, settings, mcp_registry, skill_registry, outputs, dashboards, service, subscription, web, anthropic_proxy])
app = main_app.app

# Generate per-install auth token BEFORE we bind the HTTP port. By the
# time any request lands, the token file exists. See backend/auth.py.
from backend.auth import (
    init_auth_token,
    is_path_exempt,
    request_matches_token,
    is_origin_allowed,
)
init_auth_token()


# CORS: previously wide open (`allow_origins=["*"]`), which combined with
# `allow_credentials=True` was a security footgun — any external origin
# could CORS-preflight us. Now restricted to Electron renderer origins +
# localhost dev servers. The token middleware below provides the
# *primary* defense; CORS is defense-in-depth so a misconfigured page
# can't even reach us.
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
)


@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    """Reject HTTP requests without our per-install bearer token.

    Exemptions (see `auth.is_path_exempt`):
      - `/api/subscriptions/callback` — external OAuth redirects
      - `/api/health`, `/api/version` — Electron boot handshake
      - `OPTIONS` preflights — browsers don't send Authorization on them

    Anything else requires `Authorization: Bearer <token>` OR
    `x-openswarm-token: <token>`. Failure responds with 401 and a short
    JSON error — no upstream handler sees the request.

    The anthropic-proxy route (`/api/anthropic-proxy/v1/*`) is NOT
    exempt. Its caller (the Claude Code CLI we spawn) is configured
    with `ANTHROPIC_API_KEY=<our_token>` so the CLI's `x-api-key`
    header carries our token — which `request_matches_token` accepts
    via its auth-header branches.
    """
    # Preflights never carry Authorization.
    if request.method == "OPTIONS":
        response = await call_next(request)
    elif is_path_exempt(request.url.path):
        response = await call_next(request)
    else:
        # Accept Authorization Bearer, x-openswarm-token, OR x-api-key
        # (CLI path — CLI sends x-api-key with our token as value).
        headers = dict(request.headers)
        x_api_key = headers.get("x-api-key") or headers.get("X-API-Key")
        # Accept `?token=<token>` query param too. Required for browser-driven
        # GETs that can't set headers — notably the App Builder iframe loading
        # /api/outputs/.../serve/index.html via <iframe src="...">.
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

    # Private-Network-Access header for the one remaining public-origin
    # path (OAuth callback). Harmless on other requests.
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
                # Resume handshake. The client sends this immediately
                # after the WS opens, with `last_seq` = the highest
                # seq it has applied. We replay anything newer; on
                # first connect last_seq=0 and replay() correctly
                # returns nothing (empty buffer) or the persisted
                # terminal event for already-finished sessions.
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
                # Heartbeat. Cheap, keeps NATs/firewalls from
                # silently dropping the connection. Carry the
                # client's nonce back so it can match pong→ping for
                # round-trip latency tracking if it wants.
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
        # Drops the socket from the connection list. Does NOT cancel
        # the agent task — that's intentional. See module docstring.
        ws_manager.disconnect_session(session_id, websocket)

def _ws_auth_ok(websocket: WebSocket) -> bool:
    """Validate token + origin before accepting a WS. Returns True if OK.

    On failure closes with 4401 (custom app-level code) and returns False
    — the caller must NOT call `websocket.accept()` or read any data.
    """
    headers = dict(websocket.headers)
    qp = dict(websocket.query_params)
    origin = headers.get("origin") or headers.get("Origin")
    token_ok = request_matches_token(headers, query_params=qp)
    origin_ok = is_origin_allowed(origin)
    if not (token_ok and origin_ok):
        reason = "bad token" if not token_ok else f"bad origin ({origin})"
        logger.warning(f"ws: rejecting connection to {websocket.url.path} — {reason}")
        # Can't `await websocket.close()` before accept(), so schedule the
        # close in a task. The client receives a 403 on handshake.
        import asyncio as _asyncio
        _asyncio.create_task(websocket.close(code=4401))
        return False
    return True


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
    """Catch OAuth redirect from provider, exchange code via 9Router, close window.

    Must be idempotent: the browser can legitimately hit this URL more than
    once (Chrome prefetch, user refresh, Google retrying a slow first
    redirect). The first call consumes `_pending_oauth[state]`, so a second
    call would otherwise render a misleading "Session expired" even though
    the connection is already saved. To handle that, we track recently-
    completed state values in `_completed_oauth` and return the success
    page whenever we see a duplicate.
    """
    code = request.query_params.get("code", "")
    state = request.query_params.get("state", "")
    error = request.query_params.get("error", "")

    if error:
        desc = request.query_params.get("error_description", error)
        return HTMLResponse(f'<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Authorization failed</h2><p style="color:#888">{desc}</p></div></body></html>')

    pending = _pending_oauth.pop(state, None)
    if not pending:
        # Either a duplicate callback for a state we've already exchanged,
        # or a truly stale state. Duplicates are the expected case —
        # Chrome's prefetcher and some extensions speculatively GET URLs.
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
        return HTMLResponse(f'<html><body style="background:#1a1a1a;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><div style="text-align:center"><h2>Connection failed</h2><p style="color:#888">{e}</p></div></body></html>')

    _mark_oauth_completed(state)
    logger.info(f"OAuth exchange succeeded for provider={pending.get('provider')}")
    return HTMLResponse(_SUCCESS_HTML)


@app.post("/api/browser-agent/run")
async def browser_agent_run(request: Request):
    """Run one or more browser sub-agents in parallel.
    Called by the browser_agent_mcp_server stdio subprocess."""
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
    from backend.apps.tools_lib.tools_lib import _load_all as load_all_tools, _sanitize_server_name

    body = await request.json()
    parent_session_id = body.get("parent_session_id", "")

    # Aliases that broaden the search corpus for common user intents. Without
    # these, MCPSearch("email") fails to surface Google Workspace because
    # the tool's stored description says "Gmail" not "email". Keys are
    # sanitized server names; values are extra search-hint tokens appended
    # to the haystack. Only generic synonyms — anything that's already in
    # the description doesn't need to be listed.
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
            # Pull tool sub-action names from tool_permissions._tool_descriptions
            # so MCPSearch can match against capability names (e.g. "send_email").
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
        # Ranking: substring hits across name+description+sub-tool names+
        # generic-purpose aliases. The aliases are what let "email" match
        # google-workspace even though the description says "Gmail".
        # Active-first tiebreak so the model prefers servers it has already
        # activated when both score equally.
        scored: list[tuple[int, dict]] = []
        for s in servers:
            extras = s.get("_search_extras", "")
            hay = f"{s['name']} {s['raw_name']} {s['description']} {extras}".lower()
            score = 0
            for tok in query.split():
                if tok and tok in hay:
                    # Hits in the canonical name count more; alias hits
                    # count once so a "drive" query doesn't beat the actual
                    # Drive tool description.
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
        # When the session has prior turns, fork_session alone won't
        # make the bundled CLI re-read mcp_servers — the transport
        # snapshot at launch time is what serves tool schemas. Force a
        # full fresh-session restart so the next turn rebuilds with the
        # newly-activated server in its mcp_servers dict from scratch.
        # First-turn activations don't need this (the SDK session hasn't
        # locked in yet). One-time ~200-400ms cold start on the auto-
        # continuation turn that fires right after this anyway.
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
        pass  # MCP activation captured via session dump on close

        # Auto-continue: flag the session so that after its current turn
        # ends (which is the turn that contains this MCPActivate tool
        # call), the agent loop dispatches a synthetic "continue" turn
        # with the freshly-activated tools available. Race-free — read
        # at the natural turn-boundary inside _run_agent_loop instead of
        # racing a background task against the turn's completion path.
        # Turns the typical 3-prompt flow ("check email" → MCPActivate
        # → "do it") into a 1-prompt flow.
        session.pending_continuation = True
        session.pending_continuation_prompt = (
            "[mcp:auto-continue] The MCP server you requested has been "
            f"activated (`{server_name}`). Continue with the user's original "
            "request now using the newly-available tools — do NOT ask "
            "for confirmation."
        )

        return JSONResponse({"status": "activated", "server_name": server_name, "auto_continue": True})

    return JSONResponse({"error": f"unknown action: {action}"}, status_code=400)


@app.post("/api/agents/sessions/{session_id}/compact")
async def session_compact(session_id: str):
    """Force a compaction pass on a session (Phase 2 /compact slash cmd).

    Cheap programmatic summarization (no aux LLM call), so it's safe to
    invoke at any time. Sets needs_fork=True so the next turn rebuilds
    options and ships the compacted prefix.
    """
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
    """Reset a session to a fresh sdk_session_id (Phase 2 /clear slash cmd).

    Preserves session.messages (so the chat UI keeps the visible history)
    but clears the SDK-side conversation by minting a new sdk_session_id.
    Also drops active_mcps/active_outputs so the user starts fresh.
    """
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.ws_manager import ws_manager as _ws
    session = agent_manager.sessions.get(session_id)
    if not session:
        return JSONResponse({"error": "session not found"}, status_code=404)
    session.sdk_session_id = None
    session.active_mcps = []
    session.active_outputs = []
    session.compacted_through_msg_id = None
    session.tokens = {"input": 0, "output": 0}
    session.cost_usd = 0.0
    session.needs_fork = False
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


@app.post("/api/outputs-meta/{action}")
async def outputs_meta(action: str, request: Request):
    """Back the openswarm-outputs-meta stdio MCP server.

    Mirrors mcp_meta but for Outputs/Views: list/search/activate against
    the canonical Output store. Anti-hallucination: unknown ids return
    the valid options instead of activating. Schema spilled into context
    on next turn via session.active_outputs (consumed by
    _build_outputs_context in agent_manager).
    """
    from datetime import datetime as _dt
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.outputs.outputs import _load_all as load_all_outputs, _save as save_output

    body = await request.json()
    parent_session_id = body.get("parent_session_id", "")

    def _all_outputs_ranked() -> list[dict]:
        items = []
        for o in load_all_outputs():
            items.append({
                "id": o.id,
                "name": o.name,
                "description": (o.description or "").strip(),
                "use_count": int(getattr(o, "use_count", 0) or 0),
                "last_used_at": getattr(o, "last_used_at", None),
            })
        # Sort: most-used first, then most-recent, then alphabetical.
        items.sort(key=lambda i: (-(i["use_count"] or 0), -(len(i["last_used_at"] or "")), i["name"].lower()))
        return items

    if action == "list":
        outputs = _all_outputs_ranked()
        session = agent_manager.sessions.get(parent_session_id) if parent_session_id else None
        active_set = set(session.active_outputs) if session else set()
        active = [{**o, "status": "active"} for o in outputs if o["id"] in active_set]
        available = [{**o, "status": "available"} for o in outputs if o["id"] not in active_set]
        return JSONResponse({"active": active, "available": available})

    if action == "search":
        query = (body.get("query") or "").strip().lower()
        if not query:
            return JSONResponse({"matches": []})
        outputs = _all_outputs_ranked()
        session = agent_manager.sessions.get(parent_session_id) if parent_session_id else None
        active_set = set(session.active_outputs) if session else set()
        scored: list[tuple[int, dict]] = []
        for o in outputs:
            hay = f"{o['name']} {o['description']}".lower()
            score = 0
            for tok in query.split():
                if tok and tok in hay:
                    score += 2 if tok in o["name"].lower() else 1
            # Use-count bonus so frequently-rendered Outputs surface for
            # generic queries like "dashboard" / "chart".
            if score:
                score += min(3, (o["use_count"] or 0) // 5)
                annotated = {**o, "status": "active" if o["id"] in active_set else "available"}
                scored.append((score, annotated))
        scored.sort(key=lambda t: (-t[0], 0 if t[1]["status"] == "active" else 1, t[1]["name"]))
        matches = [s for _, s in scored[:5]]
        return JSONResponse({"matches": matches})

    if action == "activate":
        output_id = (body.get("output_id") or "").strip()
        reason = body.get("reason") or ""
        if not output_id:
            return JSONResponse({"error": "output_id is required"}, status_code=400)
        if not parent_session_id:
            return JSONResponse({"error": "parent_session_id is required"}, status_code=400)
        session = agent_manager.sessions.get(parent_session_id)
        if not session:
            return JSONResponse({"error": "session not found"}, status_code=404)

        all_outputs = load_all_outputs()
        match = next((o for o in all_outputs if o.id == output_id), None)
        if not match:
            return JSONResponse({"status": "unknown_output", "available": [o.id for o in all_outputs]})

        if output_id in session.active_outputs:
            return JSONResponse({"status": "already_active", "output_id": output_id})

        session.active_outputs.append(output_id)
        session.needs_fork = True
        # Bump usage stats. Activation is a pretty strong "model intends
        # to use this" signal — even if RenderOutput isn't called, the
        # Output is meaningfully in scope. last_used_at lets ranking
        # surface "stuff I touched recently" to the model later.
        try:
            match.use_count = int(getattr(match, "use_count", 0) or 0) + 1
            match.last_used_at = _dt.now().isoformat()
            save_output(match)
        except Exception:
            logger.exception("Failed to bump Output usage stats")
        try:
            from backend.apps.agents.ws_manager import ws_manager as _ws
            await _ws.send_to_session(parent_session_id, "agent:status", {
                "session_id": parent_session_id,
                "status": session.status,
                "session": session.model_dump(mode="json"),
            })
        except Exception:
            logger.exception("Failed to broadcast post-activate session status")
        pass  # Output activation captured via session dump on close
        return JSONResponse({"status": "activated", "output_id": output_id})

    return JSONResponse({"error": f"unknown action: {action}"}, status_code=400)


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

    class _ReadyServer(uvicorn.Server):
        """Subclass that prints a machine-readable READY line on startup."""
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
