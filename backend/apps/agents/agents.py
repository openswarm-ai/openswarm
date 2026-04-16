from backend.config.Apps import SubApp
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.agents.models import AgentConfig, ApprovalResponse
from contextlib import asynccontextmanager
from fastapi import WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
import json
import logging

logger = logging.getLogger(__name__)

@asynccontextmanager
async def agents_lifespan():
    logger.info("Agents sub-app starting")
    await agent_manager.reconcile_on_startup()
    await agent_manager.restore_all_sessions()
    yield
    logger.info("Agents sub-app shutting down")
    for session_id in list(agent_manager.tasks.keys()):
        await agent_manager.stop_agent(session_id)
    await agent_manager.persist_all_sessions()

agents = SubApp("agents", agents_lifespan)

# REST Endpoints

@agents.router.get("/sessions")
async def list_sessions(dashboard_id: str = ""):
    sessions = agent_manager.get_all_sessions(dashboard_id=dashboard_id or None)
    return {"sessions": [s.model_dump(mode="json") for s in sessions]}

@agents.router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    session = agent_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.model_dump(mode="json")

@agents.router.post("/launch")
async def launch_agent(config: AgentConfig):
    session = await agent_manager.launch_agent(config)
    return {"session_id": session.id, "session": session.model_dump(mode="json")}

@agents.router.post("/sessions/{session_id}/message")
async def send_message(session_id: str, body: dict):
    prompt = body.get("prompt", "")
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    await agent_manager.send_message(
        session_id,
        prompt,
        mode=body.get("mode"),
        model=body.get("model"),
        images=body.get("images"),
        context_paths=body.get("context_paths"),
        forced_tools=body.get("forced_tools"),
        attached_skills=body.get("attached_skills"),
        hidden=body.get("hidden", False),
        selected_browser_ids=body.get("selected_browser_ids"),
    )
    return {"ok": True}

@agents.router.post("/sessions/{session_id}/stop")
async def stop_agent(session_id: str):
    await agent_manager.stop_agent(session_id)
    return {"ok": True}

@agents.router.post("/approval")
async def handle_approval(response: ApprovalResponse):
    agent_manager.handle_approval(response.request_id, {
        "behavior": response.behavior,
        "message": response.message,
        "updated_input": response.updated_input,
    })
    return {"ok": True}

@agents.router.post("/sessions/{session_id}/edit_message")
async def edit_message(session_id: str, body: dict):
    message_id = body.get("message_id")
    new_content = body.get("content", "")
    if not message_id or not new_content:
        raise HTTPException(status_code=400, detail="message_id and content are required")
    await agent_manager.edit_message(session_id, message_id, new_content)
    return {"ok": True}

@agents.router.post("/sessions/{session_id}/switch_branch")
async def switch_branch(session_id: str, body: dict):
    branch_id = body.get("branch_id", "")
    if not branch_id:
        raise HTTPException(status_code=400, detail="branch_id is required")
    await agent_manager.switch_branch(session_id, branch_id)
    return {"ok": True}

@agents.router.post("/sessions/{session_id}/generate-title")
async def generate_title(session_id: str, body: dict):
    prompt = body.get("prompt", "")
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    title = await agent_manager.generate_title(session_id, prompt)
    return {"title": title}

@agents.router.post("/sessions/{session_id}/generate-group-meta")
async def generate_group_meta(session_id: str, body: dict):
    group_id = body.get("group_id", "")
    tool_calls = body.get("tool_calls", [])
    if not group_id or not tool_calls:
        raise HTTPException(status_code=400, detail="group_id and tool_calls are required")
    result = await agent_manager.generate_group_meta(
        session_id,
        group_id,
        tool_calls,
        results_summary=body.get("results_summary"),
        is_refinement=body.get("is_refinement", False),
    )
    return result

@agents.router.patch("/sessions/{session_id}")
async def update_session(session_id: str, body: dict):
    session = agent_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    await agent_manager.update_session(session_id, **body)
    return {"ok": True}

@agents.router.get("/sessions/{session_id}/branches")
async def get_branches(session_id: str):
    session = agent_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return {
        "branches": {k: v.model_dump(mode="json") for k, v in session.branches.items()},
        "active_branch_id": session.active_branch_id,
    }

@agents.router.post("/sessions/{session_id}/duplicate")
async def duplicate_session(session_id: str, body: dict = {}):
    try:
        session = await agent_manager.duplicate_session(
            session_id,
            dashboard_id=body.get("dashboard_id"),
            up_to_message_id=body.get("up_to_message_id"),
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"session": session.model_dump(mode="json")}

@agents.router.post("/sessions/{session_id}/close")
async def close_session(session_id: str):
    try:
        await agent_manager.close_session(session_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"ok": True}

@agents.router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    await agent_manager.delete_session(session_id)
    return {"ok": True}

@agents.router.get("/history")
async def get_history(q: str = "", limit: int = 20, offset: int = 0, dashboard_id: str = ""):
    return agent_manager.get_history(
        q=q, limit=limit, offset=offset,
        dashboard_id=dashboard_id or None,
    )

@agents.router.get("/sessions/{session_id}/browser-agents")
async def get_browser_agent_children(session_id: str):
    children = agent_manager.get_browser_agent_children(session_id)
    return {"sessions": children}

@agents.router.post("/sessions/{session_id}/resume")
async def resume_session(session_id: str):
    try:
        session = await agent_manager.resume_session(session_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"session": session.model_dump(mode="json")}


# ---------------------------------------------------------------------------
# 9Router / Subscription endpoints
# ---------------------------------------------------------------------------

@agents.router.get("/subscriptions/status")
async def subscriptions_status():
    """Check if 9Router is running and list connected providers."""
    from backend.apps.nine_router import is_running, get_providers, get_models
    if not is_running():
        return {"running": False, "providers": [], "models": []}
    providers = await get_providers()
    models = await get_models()
    return {"running": True, "providers": providers, "models": models}


@agents.router.post("/subscriptions/connect")
async def subscriptions_connect(body: dict):
    """Start OAuth flow for a subscription provider."""
    from backend.apps.nine_router import is_running, ensure_running, start_oauth
    provider = body.get("provider", "")
    if not provider:
        raise HTTPException(status_code=400, detail="provider required")

    if not is_running():
        await ensure_running()
        if not is_running():
            raise HTTPException(status_code=503, detail="9Router not available. Please install Node.js.")

    try:
        result = await start_oauth(provider)

        # For auth_code flows, store pending state so the callback can exchange
        if result.get("flow") == "authorization_code" and result.get("state"):
            from backend.main import _pending_oauth
            _pending_oauth[result["state"]] = {
                "provider": provider,
                "code_verifier": result.get("code_verifier", ""),
                "redirect_uri": result.get("redirect_uri", ""),
            }

        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@agents.router.post("/subscriptions/poll")
async def subscriptions_poll(body: dict):
    """Poll for OAuth completion."""
    from backend.apps.nine_router import poll_oauth
    provider = body.get("provider", "")
    device_code = body.get("device_code", "")
    if not provider or not device_code:
        raise HTTPException(status_code=400, detail="provider and device_code required")

    try:
        result = await poll_oauth(
            provider, device_code,
            code_verifier=body.get("code_verifier"),
            extra_data=body.get("extra_data"),
        )
        if result.get("success"):
            from backend.apps.analytics.collector import record as _analytics
            _analytics("subscription.connected", {"provider": provider})
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@agents.router.post("/subscriptions/exchange")
async def subscriptions_exchange(body: dict):
    """Exchange OAuth code for tokens via 9Router."""
    from backend.apps.nine_router import exchange_oauth
    provider = body.get("provider", "")
    code = body.get("code", "")
    redirect_uri = body.get("redirect_uri", "")
    code_verifier = body.get("code_verifier", "")
    state = body.get("state", "")

    if not provider or not code:
        raise HTTPException(status_code=400, detail="provider and code required")

    try:
        result = await exchange_oauth(provider, code, redirect_uri, code_verifier, state)
        if result.get("success"):
            from backend.apps.analytics.collector import record as _analytics
            _analytics("subscription.connected", {"provider": provider})
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@agents.router.get("/subscriptions/models")
async def subscriptions_models():
    """List all models available through connected subscriptions."""
    from backend.apps.nine_router import is_running, get_models
    if not is_running():
        return {"models": []}
    models = await get_models()
    return {"models": models}


@agents.router.get("/models")
async def list_models():
    """Return the chat-picker model list grouped by provider.

    Intersects BUILTIN_MODELS with runtime availability:
    - Anthropic models are visible if an API key is set OR 9Router has the
      `claude` subscription connected.
    - Subscription-only models (OpenAI/Google/Copilot routed via 9Router's
      cx/gc/gh prefixes) are visible only when 9Router is up AND that
      provider has an active connection.

    The frontend already calls this endpoint from
    frontend/src/shared/state/modelsSlice.ts:24 and falls back to hardcoded
    Claude entries on failure, so the response shape is
    `{"models": {"provider_name": [{value, label, context_window}, ...]}}`.
    """
    from backend.apps.agents.providers.registry import BUILTIN_MODELS
    from backend.apps.nine_router import is_running as _9r_running, get_providers as _9r_providers
    from backend.apps.settings.settings import load_settings

    settings = load_settings()
    nine_router_up = _9r_running()

    connected: set[str] = set()
    if nine_router_up:
        try:
            providers_data = await _9r_providers()
            conns = providers_data.get("connections", []) if isinstance(providers_data, dict) else []
            raw_providers = {c.get("provider", "") for c in conns if c.get("isActive") or c.get("testStatus") == "active"}
            # Map 9Router's provider names to our BUILTIN_MODELS api field names.
            # 9Router stores "github" but our models use api="github-copilot",
            # 9Router stores "codex" but our models use api="codex" (matches),
            # 9Router stores "claude" but our models use api="anthropic", etc.
            _9R_TO_API = {
                "github": "github-copilot",
                "claude": "anthropic",
                "codex": "codex",
                "gemini-cli": "gemini-cli",
            }
            connected = raw_providers | {_9R_TO_API.get(p, p) for p in raw_providers}
        except Exception as e:
            logger.debug(f"Failed to fetch 9Router providers: {e}")

    def _serialize(models: list[dict]) -> list[dict]:
        return [
            {
                "value": m["value"],
                "label": m["label"],
                "context_window": m.get("context_window", 128_000),
                "reasoning": bool(m.get("reasoning", False)),
            }
            for m in models
        ]

    has_api_key = bool(getattr(settings, "anthropic_api_key", None))
    is_openswarm_pro = (
        getattr(settings, "connection_mode", "own_key") == "openswarm-pro"
        and bool(getattr(settings, "openswarm_bearer_token", None))
    )
    has_claude_sub = "claude" in connected

    result: dict[str, list[dict]] = {}

    # Anthropic models: emit under "OpenSwarm Pro" (proxy-routed, adaptive
    # values) and/or "Anthropic" (direct API key OR 9Router claude sub). When
    # both the proxy and the personal claude sub are active we emit both
    # groups, with the Anthropic group using the pinned "-cc" variants so a
    # per-call selection actually routes through 9Router instead of the proxy.
    anthropic_models = BUILTIN_MODELS.get("Anthropic", [])
    adaptive = [m for m in anthropic_models if m.get("route") != "cc"]
    cc_variants = [m for m in anthropic_models if m.get("route") == "cc"]

    if is_openswarm_pro and has_claude_sub:
        result["OpenSwarm Pro"] = _serialize(adaptive)
        result["Anthropic"] = _serialize(cc_variants)
    elif is_openswarm_pro:
        result["OpenSwarm Pro"] = _serialize(adaptive)
    elif has_api_key or has_claude_sub:
        result["Anthropic"] = _serialize(adaptive)

    # Non-Anthropic providers (OpenAI, Google, OpenSwarm/Copilot, etc.) —
    # visibility is gated by 9Router's connected providers set.
    for provider_name, models in BUILTIN_MODELS.items():
        if provider_name == "Anthropic":
            continue
        visible = []
        for m in models:
            api = m.get("api", "")
            if api == "github-copilot":
                # Hidden from end users for now — `gh/` path lives in the
                # registry but the Copilot subscription card is "Coming soon".
                continue
            if m.get("subscription_only"):
                if not nine_router_up or api not in connected:
                    continue
            visible.append({
                "value": m["value"],
                "label": m["label"],
                "context_window": m.get("context_window", 128_000),
                "reasoning": bool(m.get("reasoning", False)),
            })
        if visible:
            result[provider_name] = visible

    return {"models": result}


@agents.router.post("/subscriptions/disconnect")
async def subscriptions_disconnect(body: dict):
    """Disconnect a subscription provider via 9Router."""
    import httpx
    provider = body.get("provider", "")
    if not provider:
        raise HTTPException(status_code=400, detail="provider required")

    try:
        from backend.apps.nine_router import NINE_ROUTER_API, get_providers
        providers_data = await get_providers()
        connections = providers_data.get("connections", []) if isinstance(providers_data, dict) else []
        conn = next((c for c in connections if c.get("provider") == provider), None)
        if conn and conn.get("id"):
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.delete(f"{NINE_ROUTER_API}/providers/{conn['id']}")
            from backend.apps.analytics.collector import record as _analytics
            _analytics("subscription.disconnected", {"provider": provider})
            return {"ok": True}
        return {"ok": False, "error": "Connection not found"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

