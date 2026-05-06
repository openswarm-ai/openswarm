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

    # Pre-flight MCP suggestion (Phase 3, Layer N). Runs in parallel with
    # the agent launch path — if it produces suggestions, they're
    # surfaced inline in the chat via agent:mcp_suggestions WS event.
    # Fails open: any error from the classifier is swallowed and the
    # agent proceeds normally. The classifier is short-circuited for
    # obviously-local prompts (greetings, shell commands, file paths).
    try:
        from backend.apps.agents.mcp_preflight import run_preflight
        from backend.apps.agents.ws_manager import ws_manager as _ws

        async def _emit_preflight():
            try:
                result = await run_preflight(prompt)
                if result.get("suggestions") or result.get("is_vague"):
                    await _ws.send_to_session(session_id, "agent:mcp_suggestions", {
                        "session_id": session_id,
                        "suggestions": result.get("suggestions", []),
                        "is_vague": bool(result.get("is_vague")),
                    })
            except Exception:
                pass

        # Non-blocking — don't gate the agent on the classifier.
        import asyncio as _asyncio
        _asyncio.create_task(_emit_preflight())
    except Exception:
        pass

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
        client_message_id=body.get("client_message_id"),
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


@agents.router.post("/sessions/{session_id}/warm-cache")
async def warm_session_cache(session_id: str):
    """Fire a max_tokens=1 dummy request through the agent path so
    Anthropic processes the system+tools prefix and writes the prompt
    cache. The next real user turn lands a cache hit instead of paying
    cold-start TTFT. Non-blocking, fire-and-forget on the frontend.
    Returns 200 even on failure (best-effort).
    """
    try:
        await agent_manager.warm_prompt_cache(session_id)
    except Exception:
        pass
    return {"ok": True}


# ---------------------------------------------------------------------------
# 9Router / Subscription endpoints
# ---------------------------------------------------------------------------

@agents.router.get("/subscriptions/status")
async def subscriptions_status():
    """Check if 9Router is running and list connected providers."""
    from backend.apps.nine_router import is_running, get_providers, get_models
    if not is_running():
        return {"running": False, "providers": [], "models": []}
    connections = await get_providers()
    models = await get_models()
    # Frontend consumers (OnboardingModal, Settings) read
    # `data.providers.connections` — preserve that envelope here.
    return {"running": True, "providers": {"connections": connections}, "models": models}


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
            from backend.apps.service.client import sync as _sync
            from backend.apps.settings.settings import load_settings
            _sync(load_settings().model_dump())
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
            from backend.apps.service.client import sync as _sync
            from backend.apps.settings.settings import load_settings
            _sync(load_settings().model_dump())
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
            conns = await _9r_providers()
            # `get_providers` now unwraps 9Router's {"connections":[...]} envelope
            # into a plain list of connection dicts.
            raw_providers = {c.get("provider", "") for c in conns if c.get("isActive") or c.get("testStatus") == "active"}
            # Map 9Router's provider names to our BUILTIN_MODELS api field names.
            # 9Router stores "claude" but our models use api="anthropic", etc.
            _9R_TO_API = {
                "claude": "anthropic",
                "codex": "codex",
                "gemini-cli": "gemini-cli",
                # Antigravity is a separate OAuth lane to the same
                # underlying Gemini models — treat it as the Google-
                # subscription provider for model-visibility purposes.
                "antigravity": "gemini-cli",
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
    adaptive = [m for m in anthropic_models if m.get("route") not in ("cc", "api")]
    cc_variants = [m for m in anthropic_models if m.get("route") == "cc"]
    api_variants = [m for m in anthropic_models if m.get("route") == "api"]

    # Anthropic surface depends on which credentials are wired:
    #   - is_openswarm_pro + has_claude_sub: two groups. "OpenSwarm Pro" uses
    #     the unsuffixed values (proxy-routed); "Anthropic" uses the -cc
    #     variants which 9Router routes via the user's own claude
    #     subscription, bypassing the Pro proxy.
    #   - is_openswarm_pro + has_api_key only (no claude sub): the -cc route
    #     would fail with "No credentials for provider: claude" because
    #     9Router has no claude provider node. The API key sits dormant
    #     while proxy mode is active — the user must switch connection_mode
    #     to own_key in Settings to use the key directly. We surface a
    #     one-line note instead of a broken-route group.
    #   - is_openswarm_pro alone: only the proxy-routed group.
    #   - has_api_key or has_claude_sub without proxy: single Anthropic group
    #     using adaptive values, which fall through to 9Router and use
    #     whichever creds are available.
    notes: list[dict] = []
    if is_openswarm_pro:
        # Always show the OpenSwarm Pro group. Then layer on whatever
        # alternate Anthropic credentials the user has (claude-sub via cc/,
        # api-key via direct). Both variants live under "Anthropic" — the
        # group header disambiguates against "OpenSwarm Pro"; api-key
        # variants keep an "(API key)" suffix to distinguish from cc/.
        result["OpenSwarm Pro"] = _serialize(adaptive)
        anth_alternates: list[dict] = []
        if has_claude_sub:
            anth_alternates += cc_variants
        if has_api_key:
            anth_alternates += api_variants
        if anth_alternates:
            result["Anthropic"] = _serialize(anth_alternates)
    elif has_api_key or has_claude_sub:
        # Pure own_key mode. The adaptive route already uses the api_key
        # (or falls through to 9Router for the claude sub) — no need for
        # explicit -api / -cc variants in the picker.
        result["Anthropic"] = _serialize(adaptive)

    # Non-Anthropic providers (OpenAI, Google, etc.).
    # Subscription-routed models (api=codex/gemini-cli/antigravity) are
    # gated by 9Router's connected providers set.
    # API-key-routed models (route="api", api=openai/gemini) are gated by
    # the corresponding *_api_key being set in settings — same pattern as
    # the Anthropic -api variants.
    has_openai_key = bool(getattr(settings, "openai_api_key", None))
    has_google_key = bool(getattr(settings, "google_api_key", None))
    for provider_name, models in BUILTIN_MODELS.items():
        if provider_name == "Anthropic":
            continue
        visible = []
        for m in models:
            api = m.get("api", "")
            route = m.get("route")
            if route == "api":
                # Direct API key path. Show only when the matching key is set.
                if api == "openai" and not has_openai_key:
                    continue
                if api == "gemini" and not has_google_key:
                    continue
            elif m.get("subscription_only"):
                # Subscription path. Show only when 9Router has the lane up.
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

    return {"models": result, "notes": notes}


@agents.router.post("/subscriptions/disconnect")
async def subscriptions_disconnect(body: dict):
    """Disconnect a subscription provider via 9Router."""
    import httpx
    provider = body.get("provider", "")
    if not provider:
        raise HTTPException(status_code=400, detail="provider required")

    try:
        from backend.apps.nine_router import NINE_ROUTER_API, get_providers
        connections = await get_providers()
        conn = next((c for c in connections if c.get("provider") == provider), None)
        if conn and conn.get("id"):
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.delete(f"{NINE_ROUTER_API}/providers/{conn['id']}")
            from backend.apps.service.client import sync as _sync
            from backend.apps.settings.settings import load_settings
            _sync(load_settings().model_dump())
            return {"ok": True}
        return {"ok": False, "error": "Connection not found"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

