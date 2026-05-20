from backend.config.Apps import SubApp
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.ws_manager import ws_manager
from backend.apps.agents.models import AgentConfig, ApprovalResponse
from contextlib import asynccontextmanager
from fastapi import WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
import asyncio
import json
import logging

logger = logging.getLogger(__name__)

# Dedup concurrent generate-group-meta calls; collapses the 429 thundering herd by sharing one upstream Future per (session, group).
_group_meta_inflight: dict[tuple[str, str], asyncio.Future] = {}

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


@agents.router.get("/sessions")
async def list_sessions(dashboard_id: str = ""):
    sessions = agent_manager.get_all_sessions(dashboard_id=dashboard_id or None)
    return {"sessions": [s.model_dump(mode="json") for s in sessions]}

@agents.router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Returns the session by id.

    Falls back to a disk load when the session isn't in the in-memory
    dict. Without this, any surface that queries a session before the
    dashboard has restored it (Apps editor opened cold, deep link to a
    chat, a workflow step inspecting an old session) hits a 404 even
    though the JSON file is sitting on disk. The disk-load path is
    O(1) memory hit after the first call: resume_session moves the
    session into agent_manager.sessions and the next GET short-circuits
    on the in-memory check.
    """
    session = agent_manager.get_session(session_id)
    if not session:
        try:
            session = await agent_manager.resume_session(session_id)
        except ValueError:
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

    # Run MCP-suggestion classifier in parallel with the agent launch; fails open.
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
        "trust_pattern": response.trust_pattern,
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

    # Dedup: share an in-flight Future across callers; refinement requests bypass since they may want fresh results.
    is_refinement = body.get("is_refinement", False)
    key = (session_id, group_id)
    if not is_refinement:
        existing = _group_meta_inflight.get(key)
        if existing is not None and not existing.done():
            try:
                return await existing
            except Exception:
                # In-flight call failed; retry ourselves rather than propagate someone else's error.
                pass

    future: asyncio.Future = asyncio.get_event_loop().create_future()
    if not is_refinement:
        _group_meta_inflight[key] = future
    try:
        result = await agent_manager.generate_group_meta(
            session_id,
            group_id,
            tool_calls,
            results_summary=body.get("results_summary"),
            is_refinement=is_refinement,
        )
        if not future.done():
            future.set_result(result)
        return result
    except Exception as e:
        if not future.done():
            future.set_exception(e)
        raise
    finally:
        if not is_refinement and _group_meta_inflight.get(key) is future:
            _group_meta_inflight.pop(key, None)

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
    """Fire a max_tokens=1 dummy request to prime the Anthropic prompt cache; best-effort."""
    try:
        await agent_manager.warm_prompt_cache(session_id)
    except Exception:
        pass
    return {"ok": True}


@agents.router.get("/subscriptions/status")
async def subscriptions_status():
    """Check if 9Router is running and list connected providers."""
    from backend.apps.nine_router import is_running, get_providers, get_models
    if not is_running():
        return {"running": False, "providers": [], "models": []}
    connections = await get_providers()
    models = await get_models()
    # Frontend reads data.providers.connections; preserve the envelope.
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

    # Reconnecting gemini-cli must wipe antigravity; registry prefers AG and a stale AG token would 400 after gemini-cli refreshes.
    cascade = _PROVIDER_CASCADE_REMOVES.get(provider, [])
    if cascade:
        try:
            await _delete_provider_connections(cascade)
        except Exception:
            pass

    try:
        result = await start_oauth(provider)

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


@agents.router.post("/probe-model")
async def probe_model(body: dict):
    """1-token health probe; returns latency or skipped when the route is ambiguous (silent beats wrong)."""
    import time as _time
    short_name = (body or {}).get("model") or ""
    if not short_name:
        return {"ok": False, "error": "model required"}
    try:
        from backend.apps.agents.providers.registry import (
            resolve_model_id_for_sdk,
            get_api_type,
            _find_builtin_model,
        )
        from backend.apps.settings.settings import load_settings
        from backend.apps.nine_router import is_running as _9r_running
        settings = load_settings()
        api_type = get_api_type(short_name)
        resolved = resolve_model_id_for_sdk(short_name, settings)
        entry = _find_builtin_model(short_name) or {}
        route = entry.get("route")
        connection_mode = getattr(settings, "connection_mode", "own_key")

        import anthropic
        client = None

        # Routing mirrors agent_manager: prefix takes precedence over Pro.
        resolved_is_9router = (
            isinstance(resolved, str)
            and resolved.startswith(("cc/", "cx/", "gc/", "ag/", "openrouter/", "gemini/"))
        )

        if resolved_is_9router:
            if not _9r_running():
                return {"ok": True, "skipped": True}
            client = anthropic.AsyncAnthropic(api_key="9router", base_url="http://localhost:20128")
        elif route == "api" and api_type == "anthropic" and getattr(settings, "anthropic_api_key", None):
            client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        elif api_type == "anthropic" and connection_mode == "openswarm-pro":
            bearer = getattr(settings, "openswarm_bearer_token", "") or ""
            proxy_url = (getattr(settings, "openswarm_proxy_url", None) or "https://api.openswarm.com").rstrip("/")
            if not bearer:
                return {"ok": True, "skipped": True}
            client = anthropic.AsyncAnthropic(auth_token=bearer, base_url=proxy_url)
        elif api_type == "anthropic" and getattr(settings, "anthropic_api_key", None):
            client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        else:
            if not _9r_running():
                return {"ok": True, "skipped": True}
            client = anthropic.AsyncAnthropic(api_key="9router", base_url="http://localhost:20128")

        t0 = _time.monotonic()
        await client.messages.create(
            model=resolved,
            max_tokens=1,
            messages=[{"role": "user", "content": "ping"}],
            timeout=10.0,
        )
        return {"ok": True, "latency_ms": int((_time.monotonic() - t0) * 1000)}
    except Exception as e:
        msg = str(e).splitlines()[0] if str(e) else type(e).__name__
        low = msg.lower()
        # Suppress transients: chat retries naturally and probe-time alias 404s often differ from chat resolution.
        if any(s in low for s in (
            "timeout", "timed out",
            "connection reset", "connection aborted",
            "rate_limit", "rate limit", "429",
            "internal server error", "503", "502", "504",
            "reset after",
            "provider returned error",
            "404", "not_found", "not found",
        )):
            return {"ok": True, "skipped": True}
        return {"ok": False, "error": msg[:240]}


@agents.router.get("/models")
async def list_models():
    """Picker model list, grouped by provider, intersected with available creds."""
    from backend.apps.agents.providers.registry import BUILTIN_MODELS
    from backend.apps.nine_router import is_running as _9r_running, get_providers as _9r_providers
    from backend.apps.settings.settings import load_settings

    settings = load_settings()
    nine_router_up = _9r_running()

    connected: set[str] = set()
    if nine_router_up:
        try:
            conns = await _9r_providers()
            raw_providers = {c.get("provider", "") for c in conns if c.get("isActive") or c.get("testStatus") == "active"}
            # 9Router uses "claude"; our models use api="anthropic". Map across.
            _9R_TO_API = {
                "claude": "anthropic",
                "codex": "codex",
                "gemini-cli": "gemini-cli",
                "antigravity": "gemini-cli",  # AG = same Gemini models, separate OAuth.
            }
            connected = raw_providers | {_9R_TO_API.get(p, p) for p in raw_providers}
        except Exception as e:
            logger.debug(f"Failed to fetch 9Router providers: {e}")

    def _serialize(models: list[dict]) -> list[dict]:
        # Tiers describe the model; billing_kind describes the wallet. Pricing shown only for paid.
        from backend.apps.agents.providers.registry import (
            COST_PER_1M_TOKENS,
            compute_tiers,
            compute_billing_kind,
        )
        out = []
        for m in models:
            input_cost = output_cost = 0.0
            for (_p, _v), rates in COST_PER_1M_TOKENS.items():
                if _v == m["value"]:
                    input_cost, output_cost = rates
                    break
            api = m.get("api", "")
            route = m.get("route")
            billing_kind = compute_billing_kind(
                api=api, route=route, is_or_free=False, settings=settings,
            )
            tiers = compute_tiers(
                m.get("model_id", m["value"]),
                m["label"],
                output_cost,
                bool(m.get("reasoning", False)),
            )
            out.append({
                "value": m["value"],
                "label": m["label"],
                "context_window": m.get("context_window", 128_000),
                "reasoning": bool(m.get("reasoning", False)),
                "input_cost_per_1m": input_cost,
                "output_cost_per_1m": output_cost,
                # Strict free; subscriptions show via the picker's Subscription chip.
                "is_free": billing_kind == "free",
                "billing_kind": billing_kind,
                "tiers": list(tiers),
            })
        return out

    has_api_key = bool(getattr(settings, "anthropic_api_key", None))
    is_openswarm_pro = (
        getattr(settings, "connection_mode", "own_key") == "openswarm-pro"
        and bool(getattr(settings, "openswarm_bearer_token", None))
    )
    has_claude_sub = "claude" in connected

    result: dict[str, list[dict]] = {}

    anthropic_models = BUILTIN_MODELS.get("Anthropic", [])
    adaptive = [m for m in anthropic_models if m.get("route") not in ("cc", "api")]
    cc_variants = [m for m in anthropic_models if m.get("route") == "cc"]
    api_variants = [m for m in anthropic_models if m.get("route") == "api"]

    # Pro mode splits into Pro proxy + Anthropic alternates; own-key collapses to one adaptive group.
    notes: list[dict] = []
    if is_openswarm_pro:
        result["OpenSwarm Pro"] = _serialize(adaptive)
        anth_alternates: list[dict] = []
        if has_claude_sub:
            anth_alternates += cc_variants
        if has_api_key:
            anth_alternates += api_variants
        if anth_alternates:
            result["Anthropic"] = _serialize(anth_alternates)
    elif has_api_key or has_claude_sub:
        result["Anthropic"] = _serialize(adaptive)

    has_openai_key = bool(getattr(settings, "openai_api_key", None))
    has_google_key = bool(getattr(settings, "google_api_key", None))
    has_openrouter_key = bool(getattr(settings, "openrouter_api_key", None))
    from backend.apps.agents.providers.registry import (
        COST_PER_1M_TOKENS as _CPM,
        compute_tiers as _ct_native,
        compute_billing_kind as _cbk_native,
    )
    for provider_name, models in BUILTIN_MODELS.items():
        if provider_name == "Anthropic":
            continue
        visible = []
        for m in models:
            api = m.get("api", "")
            route = m.get("route")
            if route == "api":
                if api == "openai" and not has_openai_key:
                    continue
                if api == "gemini" and not has_google_key:
                    continue
            elif m.get("subscription_only"):
                if not nine_router_up or api not in connected:
                    continue
            in_cost = out_cost = 0.0
            for (_p, _v), rates in _CPM.items():
                if _v == m["value"]:
                    in_cost, out_cost = rates
                    break
            billing_kind = _cbk_native(
                api=api, route=route, is_or_free=False, settings=settings,
            )
            tiers = _ct_native(
                m.get("model_id", m["value"]),
                m["label"],
                out_cost,
                bool(m.get("reasoning", False)),
            )
            visible.append({
                "value": m["value"],
                "label": m["label"],
                "context_window": m.get("context_window", 128_000),
                "reasoning": bool(m.get("reasoning", False)),
                "input_cost_per_1m": in_cost,
                "output_cost_per_1m": out_cost,
                "is_free": billing_kind == "free",
                "billing_kind": billing_kind,
                "tiers": list(tiers),
            })
        if visible:
            result[provider_name] = visible

    # Fetch OpenRouter catalog directly (independent of 9Router) so picker fills the moment a key lands.
    if has_openrouter_key:
        try:
            from backend.apps.agents.providers.registry import fetch_openrouter_models
            or_models = await fetch_openrouter_models(settings.openrouter_api_key)
        except Exception as e:
            logger.debug(f"OpenRouter catalog fetch failed: {e}")
            or_models = []
        if or_models:
            by_vendor: dict[str, list[dict]] = {}
            from backend.apps.agents.providers.registry import (
                compute_tiers as _ct,
                compute_billing_kind as _cbk,
            )
            for m in or_models:
                v = m.get("vendor") or "Other"
                in_cost = float(m.get("input_cost_per_1m", 0.0))
                out_cost = float(m.get("output_cost_per_1m", 0.0))
                is_free = bool(m.get("is_free", False))
                billing_kind = _cbk(
                    api="openrouter", route="openrouter", is_or_free=is_free,
                    settings=settings,
                )
                tiers = _ct(
                    m.get("model_id", m["value"]),
                    m["label"],
                    out_cost,
                    bool(m.get("reasoning", False)),
                )
                by_vendor.setdefault(v, []).append({
                    "value": m["value"],
                    "label": m["label"],
                    "context_window": m.get("context_window", 128_000),
                    "reasoning": bool(m.get("reasoning", False)),
                    "input_cost_per_1m": in_cost,
                    "output_cost_per_1m": out_cost,
                    "is_free": is_free,
                    "billing_kind": billing_kind,
                    "tiers": list(tiers),
                    "max_completion_tokens": m.get("max_completion_tokens"),
                })
            for vendor in sorted(by_vendor.keys()):
                pretty = (
                    vendor.replace("-", " ").replace("_", " ").title().replace("Ai", "AI")
                )
                entries = sorted(by_vendor[vendor], key=lambda x: x["label"].lower())
                result[f"OpenRouter · {pretty}"] = entries

    # Custom OpenAI-compatible providers (Ollama Cloud, Together, etc); addressed via custom/<slug>/<model_id>.
    from backend.apps.agents.providers.registry import _custom_provider_slug_for_lookup
    for cp in (getattr(settings, "custom_providers", None) or []):
        cp_name = (getattr(cp, "name", "") or "").strip()
        cp_base_url = (getattr(cp, "base_url", "") or "").strip()
        cp_models = getattr(cp, "models", None) or []
        if not cp_name or not cp_base_url or not cp_models:
            continue
        slug = _custom_provider_slug_for_lookup(cp_name)
        entries: list[dict] = []
        for m in cp_models:
            bare = (m.get("value") or m.get("id") or "").strip()
            if not bare:
                continue
            label = (m.get("label") or bare).strip() or bare
            ctx = m.get("context_window")
            if not isinstance(ctx, int) or ctx <= 0:
                ctx = 128_000
            entries.append({
                "value": f"custom/{slug}/{bare}",
                "label": label,
                "context_window": ctx,
                "reasoning": bool(m.get("reasoning", False)),
                "input_cost_per_1m": 0.0,
                "output_cost_per_1m": 0.0,
                "is_free": False,
                "billing_kind": "api_key",
                "tiers": [3, 3, 1],
            })
        if entries:
            result[cp_name] = entries

    return {"models": result, "notes": notes}


# gemini-cli and antigravity are two Google OAuth lanes; registry prefers AG, so we cascade-wipe AG when reconnecting gemini-cli to avoid stale-AG 400s. One-directional: AG operations MUST NOT cascade back.
_PROVIDER_CASCADE_REMOVES: dict[str, list[str]] = {
    "gemini-cli": ["antigravity"],
}


async def _delete_provider_connections(providers: list[str]) -> int:
    """Delete 9Router connections in `providers`; returns count removed, silent on 9Router unreachable."""
    import httpx
    from backend.apps.nine_router import NINE_ROUTER_API, get_providers
    try:
        connections = await get_providers()
    except Exception:
        return 0
    targets = [c for c in connections if c.get("provider") in providers and c.get("id")]
    removed = 0
    async with httpx.AsyncClient(timeout=10.0) as client:
        for c in targets:
            try:
                await client.delete(f"{NINE_ROUTER_API}/providers/{c['id']}")
                removed += 1
            except Exception:
                pass
    return removed


@agents.router.post("/subscriptions/disconnect")
async def subscriptions_disconnect(body: dict):
    """Disconnect a subscription provider via 9Router; cascades-wipe Google's paired lanes."""
    provider = body.get("provider", "")
    if not provider:
        raise HTTPException(status_code=400, detail="provider required")

    try:
        to_remove = [provider, *_PROVIDER_CASCADE_REMOVES.get(provider, [])]
        removed = await _delete_provider_connections(to_remove)
        if removed:
            from backend.apps.service.client import sync as _sync
            from backend.apps.settings.settings import load_settings
            _sync(load_settings().model_dump())
            return {"ok": True}
        return {"ok": False, "error": "Connection not found"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

