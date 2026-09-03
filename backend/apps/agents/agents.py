import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import Any, Dict

from fastapi import HTTPException, Request
from typeguard import typechecked

from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.fault_injection import announce as p_announce_armed_faults
from backend.apps.agents.core.models import AgentConfig, AgentSession, ApprovalResponse
from backend.apps.agents.core.seq_log import seq_log
from backend.apps.agents.core.ws_manager import preview_text
from backend.apps.agents.manager.session.history_compaction import estimate_post_compact_input
from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)

MCP_SUGGEST_COOLDOWN_S = 300.0
p_mcp_suggest_cooldown: dict[str, float] = {}

# Dedup concurrent generate-group-meta calls; collapses the 429 thundering herd by sharing one upstream Future per (session, group).
p_group_meta_inflight: dict[tuple[str, str], asyncio.Future] = {}

@asynccontextmanager
async def agents_lifespan():
    logger.info("Agents sub-app starting")
    p_announce_armed_faults()
    await agent_manager.reconcile_on_startup()
    await agent_manager.restore_all_sessions()
    # Off the critical path: crash-cut turns resume themselves once everything is hydrated.
    asyncio.create_task(agent_manager.auto_resume_crashed_turns())
    from backend.apps.agents.manager.run.client_pool import start_pool_sweeper, stop_pool_sweeper, dispose_all_clients
    pool_sweeper = start_pool_sweeper(agent_manager.client_pool)
    yield
    logger.info("Agents sub-app shutting down")
    # Stamp before stopping: once stop_agent has run, a live chat is indistinguishable from one the user stopped.
    agent_manager.note_shutdown_stops()
    for session_id in list(agent_manager.tasks.keys()):
        await agent_manager.stop_agent(session_id)
    await agent_manager.persist_all_sessions()
    # Cancel the sweeper before disposing so a background sweep can't race the shutdown teardown.
    await stop_pool_sweeper(pool_sweeper)
    # Persistent CLI clients outlive turns; without this a uvicorn reload/quit orphans one subprocess per live session.
    await dispose_all_clients(agent_manager.client_pool)

agents = SubApp("agents", agents_lifespan)


@typechecked
def p_session_list_item(session: AgentSession) -> Dict[str, Any]:
    """Serialize dashboard metadata without retaining the full chat history."""
    data = session.model_dump(mode="json", exclude={"messages"})
    messages = session.messages
    first_user_content = next(
        (message.content for message in messages if message.role == "user"),
        "",
    )
    data.update(
        messages=[],
        last_message_preview=preview_text(messages),
        first_user_message=(
            first_user_content[:200] if isinstance(first_user_content, str) else ""
        ),
        message_count=len(messages),
    )
    return data


@agents.router.get("/sessions")
async def list_sessions(dashboard_id: str = ""):
    sessions = agent_manager.get_all_sessions(dashboard_id=dashboard_id or None)
    return {"sessions": [p_session_list_item(s) for s in sessions]}

@agents.router.get("/sessions/{session_id}/followups")
async def predict_followups_route(session_id: str, count: int = 3):
    """Chat-specific next-message suggestions in the user's own voice. Empty until the
    conversation has >= 2 real exchanges; always empty rather than erroring."""
    session = agent_manager.sessions.get(session_id)
    if not session:
        try:
            session = await agent_manager.resume_session(session_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="session not found")
    from backend.apps.agents.manager.predict_followups import predict_followups
    return {"suggestions": await predict_followups(session, count=max(1, min(count, 5)))}


@agents.router.get("/predict-prompts")
async def predict_prompts_route(count: int = 5):
    """Guess a few prompts the user might type next, in their own voice, from what they've already
    worked on. Drives the composer's ghost-text suggestion. Fails open to [] (no signal / no
    provider / error), so the composer just keeps its static placeholder."""
    from backend.apps.agents.manager.predict_prompts import predict_prompts
    return {"suggestions": await predict_prompts(count=max(1, min(count, 8)))}

@agents.router.get("/activity")
async def agent_activity():
    """How many agent tasks are live right now, plus seconds until the next scheduled
    workflow fires. Drives the desktop's idle-update gate so a silent update-on-idle
    never lands on top of a running agent or right before a scheduled run."""
    active = sum(1 for t in agent_manager.tasks.values() if not t.done())
    try:
        # Local import: workflows pulls in agent machinery, a module-level import here would cycle.
        from backend.apps.workflows.scheduler import seconds_to_next_fire
        next_run_in_s = seconds_to_next_fire()
    except Exception:
        # Fail open (None = no block): a broken lookahead must never wedge updates forever; the agents gate still protects running work.
        next_run_in_s = None
    return {"active": active, "next_run_in_s": next_run_in_s}

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
    # Seq read before the dump (no await between = atomic): the client seeds its WS resume cursor from this, so a REST hydrate isn't followed by a full from-zero replay of everything it just received.
    event_seq = seq_log.current_seq(session_id)
    payload = session.model_dump(mode="json")
    payload["event_seq"] = event_seq
    return payload

@agents.router.post("/sessions/{session_id}/model")
async def set_session_model(session_id: str, body: dict):
    """Pin a session to a different model, on disk.

    The renderer already switched sessions off a retired model in its own store, but that write was
    store-only, so the next metadata poll re-hydrated the dead model from disk and the "switched to
    X" notice fired again, forever (the retired-Fable reports). Persisting it makes the heal stick
    after one pass.
    """
    model = str((body or {}).get("model") or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is required")
    session = agent_manager.get_session(session_id)
    if not session:
        try:
            session = await agent_manager.resume_session(session_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="Session not found")
    session.model = model
    from backend.apps.agents.manager.session.session_store import save_session
    doc_data = session.model_dump(mode="json")
    doc_data["search_text"] = agent_manager.build_search_text(session)
    save_session(session_id, doc_data)
    return {"ok": True, "session_id": session_id, "model": model}


@agents.router.post("/launch")
async def launch_agent(config: AgentConfig):
    session = await agent_manager.launch_agent(config)
    # A launch that carries a prompt runs it as the first turn through the same path /message uses.
    if config.prompt:
        asyncio.create_task(agent_manager.send_message(session.id, config.prompt))
    else:
        # No prompt yet: the user is typing. Spend that window spawning the CLI so the first turn is a pool hit.
        asyncio.create_task(agent_manager.prewarm_client(session.id))
    return {"session_id": session.id, "session": session.model_dump(mode="json")}

@agents.router.post("/sessions/{session_id}/message")
async def send_message(session_id: str, body: dict):
    prompt = body.get("prompt", "")
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")

    # Run MCP-suggestion classifier in parallel with the agent launch; fails open.
    try:
        last_suggested = p_mcp_suggest_cooldown.get(session_id, 0.0)
        if time.monotonic() - last_suggested >= MCP_SUGGEST_COOLDOWN_S:
            from backend.apps.agents.core.mcp_preflight import run_preflight
            from backend.apps.agents.core.ws_manager import ws_manager as p_ws

            async def p_emit_preflight():
                try:
                    result = await run_preflight(prompt, task_id=session_id)
                    # Stamp the cooldown whenever the classifier RAN, not only when it suggested:
                    # a concrete prompt returns no suggestions, so the old placement never throttled
                    # and the Haiku classifier re-fired on every single turn for the session's life.
                    p_mcp_suggest_cooldown[session_id] = time.monotonic()
                    if result.get("suggestions") or result.get("is_vague"):
                        await p_ws.send_to_session(session_id, "agent:mcp_suggestions", {
                            "session_id": session_id,
                            "suggestions": result.get("suggestions", []),
                            "is_vague": bool(result.get("is_vague")),
                        })
                except Exception:
                    pass

            import asyncio as p_asyncio
            p_asyncio.create_task(p_emit_preflight())
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
        by_user=body.get("by_user", False),
        selected_browser_ids=body.get("selected_browser_ids"),
        selected_app_output_ids=body.get("selected_app_output_ids"),
        selected_setting_ids=body.get("selected_setting_ids"),
        client_message_id=body.get("client_message_id"),
    )
    return {"ok": True}

@agents.router.post("/sessions/{session_id}/stop")
async def stop_agent(session_id: str):
    # Only a human reaches this route; the watchdogs call stop_agent directly and THEIR stops may resend. Stamp here so the two can be told apart downstream.
    p_s = agent_manager.sessions.get(session_id)
    if p_s is not None:
        p_s.ended_by_user = True
    await agent_manager.stop_agent(session_id)
    # A stopped turn's parked AskUI waits would otherwise zombie for 600s and eat the next click (ENG-232).
    from backend.apps.agents.ui_request_bridge import cancel_session_waits
    cancel_session_waits(session_id)
    return {"ok": True}

@agents.router.post("/approval")
async def handle_approval(response: ApprovalResponse):
    agent_manager.handle_approval(response.request_id, {
        "behavior": response.behavior,
        "message": response.message,
        "updated_input": response.updated_input,
        "trust_pattern": response.trust_pattern,
        "set_always_allow": response.set_always_allow,
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
    # Same disk fallback as GET /sessions/{id}: after a backend restart every settled chat is on disk, not in memory, and this used to 500 on the first tool group the renderer labelled.
    if agent_manager.get_session(session_id) is None:
        try:
            await agent_manager.resume_session(session_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="Session not found")

    # Dedup: share an in-flight Future across callers; refinement requests bypass since they may want fresh results.
    is_refinement = body.get("is_refinement", False)
    key = (session_id, group_id)
    if not is_refinement:
        existing = p_group_meta_inflight.get(key)
        if existing is not None and not existing.done():
            try:
                return await existing
            except Exception:
                # In-flight call failed; retry ourselves rather than propagate someone else's error.
                pass

    future: asyncio.Future = asyncio.get_event_loop().create_future()
    if not is_refinement:
        p_group_meta_inflight[key] = future
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
        if not is_refinement and p_group_meta_inflight.get(key) is future:
            p_group_meta_inflight.pop(key, None)

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

@agents.router.get("/sessions/{session_id}/work")
async def get_session_work(session_id: str):
    """What a session DID, read off our own record: its asks, its tool trail, its final answer.

    The read that makes ReadAgentWork possible, and the whole point is the prompt it replaces. A
    parent asking a child model to restate its own work is a reproduction request on a lane whose
    filter hunts those, and it costs a model turn to fetch something already on disk (ENG-389).
    Shares `render_agent_trail` with the recap and the workflow transcript, so what is safe to send
    another model has exactly one definition."""
    from backend.apps.agents.manager.session.history_compaction import (
        get_branch_messages,
        render_agent_trail,
    )
    session = agent_manager.get_session(session_id)
    if not session:
        # Same disk fallback as GET /sessions/{id}. Without it this 404s on any session the
        # dashboard has not restored yet, which is most of them and precisely the ones worth
        # reading: the whole point is answering "what did it do" for an agent that is finished,
        # stopped or errored. Found on the packaged bits, where the plain GET returned 200 and
        # this returned 404 for the same id.
        try:
            session = await agent_manager.resume_session(session_id)
        except ValueError:
            raise HTTPException(status_code=404, detail="Session not found")
    return {
        "session_id": session_id,
        "name": session.name,
        "status": session.status,
        "work": render_agent_trail(get_branch_messages(session)),
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
    p_s = agent_manager.sessions.get(session_id)
    if p_s is not None:
        p_s.ended_by_user = True
        # Only THIS route means "the user put it away". agent_manager.close_session is also called by
        # the workflow executor for bookkeeping, so the flag belongs at the door, not in the helper.
        p_s.dismissed_by_user = True
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
async def get_history(q: str = "", limit: int = 20, offset: int = 0, dashboard_id: str = "", closed_only: int = 0):
    return agent_manager.get_history(
        q=q, limit=limit, offset=offset,
        dashboard_id=dashboard_id or None,
        closed_only=bool(closed_only),
    )

@agents.router.get("/sessions/{session_id}/browser-agents")
async def get_browser_agent_children(session_id: str):
    children = agent_manager.get_browser_agent_children(session_id)
    return {"sessions": children}

@agents.router.get("/browser-memory")
async def list_browser_memory():
    """Everything the browser agent has learned, per site, so the user can see it
    and clear it: tier-1 skills (replayable shortcuts) + tier-2 playbook (strategy
    text). Read-only; pure introspection."""
    from backend.apps.agents.browser import browser_playbook, browser_skills
    sites: dict[str, dict] = {}
    for entry in browser_playbook.list_hosts():
        sites.setdefault(entry["host"], {"host": entry["host"], "skills": [], "strategy": []})
        sites[entry["host"]]["strategy"] = entry["bullets"]
        sites[entry["host"]]["updated_at"] = entry.get("updated_at", 0)
    for host in list(sites.keys()):
        sites[host]["skills"] = browser_skills.list_skills(host)
    return {"sites": sorted(sites.values(), key=lambda s: -s.get("updated_at", 0))}


@agents.router.delete("/browser-memory/{host}")
async def forget_browser_memory(host: str):
    """Clear what the browser agent learned about one site (strategy + skills); it
    re-learns on the next successful run."""
    from backend.apps.agents.browser import browser_playbook, browser_skills
    forgot_strategy = browser_playbook.forget(host)
    forgot_skills = browser_skills.forget_host(host)
    return {"ok": True, "host": host, "forgot_strategy": forgot_strategy, "forgot_skills": forgot_skills}


@agents.router.post("/sessions/{session_id}/resume")
async def resume_session(session_id: str):
    try:
        session = await agent_manager.resume_session(session_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"session": session.model_dump(mode="json")}


@agents.router.post("/sessions/{session_id}/compact")
async def compact_session(session_id: str):
    """Run the summarizer over older turns to free up context.

    Wired to the 'Compact memory' button in the pre-send overflow banner and the
    /compact slash command. Marks compacted_through_msg_id AND sets
    needs_fresh_session so the next turn drops the SDK convo and rebuilds from history
    with the cutoff (and distilled summary) actually applied. Auto-compact at the
    threshold now does the same (pre_send_context_guard); this button is the manual
    "do it now" for a user who wants the trim before the threshold.
    """
    session = agent_manager.sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    fired = agent_manager.maybe_compact(session, force=True)
    if fired:
        session.needs_fresh_session = True
        from backend.apps.agents.core.ws_manager import ws_manager
        try:
            await ws_manager.send_to_session(session_id, "agent:context_status", {
                "session_id": session_id,
                "reason": "compacted",
                "compacted_through_msg_id": session.compacted_through_msg_id,
            })
            await agent_manager.emit_context_update(
                session_id,
                session,
                input_tokens=estimate_post_compact_input(session),
                output_tokens=session.tokens.get("output", 0),
            )
        except Exception:
            pass
    return {"ok": True, "compacted": fired}


@agents.router.post("/sessions/{session_id}/clear")
async def clear_session(session_id: str):
    """Drop all messages from the session, keep MCPs/model/tools.

    Wired to the /clear slash command. Quickest path to recover from an
    overflow short of starting a fresh chat."""
    session = agent_manager.sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="session not found")
    session.messages = []
    session.compacted_through_msg_id = None
    session.compacted_summary = None
    session.compacted_summary_through = None
    session.tokens = {"input": 0, "output": 0}
    session.needs_fresh_session = True
    from backend.apps.agents.core.ws_manager import ws_manager
    try:
        await ws_manager.send_to_session(session_id, "agent:status", {
            "session_id": session_id,
            "status": session.status,
            "session": session.model_dump(mode="json"),
        })
        await agent_manager.emit_context_update(
            session_id,
            session,
            input_tokens=0,
            output_tokens=0,
        )
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
async def subscriptions_connect(body: dict, request: Request):
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
    from backend.apps.agents.disconnect_subscription import PROVIDER_CASCADE_REMOVES, delete_provider_connections
    cascade = PROVIDER_CASCADE_REMOVES.get(provider, [])
    if cascade:
        try:
            await delete_provider_connections(cascade)
        except Exception:
            pass

    try:
        # The port the user's app actually reached us on beats guessing the default; only consulted
        # when OPENSWARM_PORT is unset (dev uvicorn launches), never in packaged builds.
        result = await start_oauth(provider, request.url.port)

        if result.get("flow") == "authorization_code" and result.get("state"):
            from backend.apps.oauth_state import pending_oauth
            pending_oauth[result["state"]] = {
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
            from backend.apps.service.client import sync as p_sync
            from backend.apps.settings.settings import load_settings
            p_sync(load_settings().model_dump())
            from backend.apps.subscription.free_trial import clear_free_trial_on_connect
            await clear_free_trial_on_connect()
            # Background so the UI's "Connected" lands instantly; the bounce takes ~5-10s (ENG-315).
            from backend.apps.nine_router.bounce_after_connect import bounce_router_after_connect
            asyncio.create_task(bounce_router_after_connect(provider))
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@agents.router.post("/subscriptions/exchange")
async def subscriptions_exchange(body: dict):
    """Exchange OAuth code for tokens via 9Router."""
    from backend.apps.nine_router import exchange_oauth
    from backend.apps.oauth_state import (
        pending_oauth as pending_oauth,
        completed_oauth as completed_oauth,
        mark_oauth_completed as mark_completed,
    )
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
            # Claude races this path against /api/subscriptions/callback (popup + 9router patch 302 to backend); dedup so the loser sees the success page, not "Session expired".
            if state:
                pending_oauth.pop(state, None)
                mark_completed(state)
            from backend.apps.service.client import sync as do_sync
            from backend.apps.settings.settings import load_settings
            do_sync(load_settings().model_dump())
            # A connected subscription takes precedence over the free trial right away.
            from backend.apps.subscription.free_trial import clear_free_trial_on_connect
            await clear_free_trial_on_connect()
        return result
    except Exception as e:
        if state and state in completed_oauth:
            return {"success": True, "deduped": True}
        raise HTTPException(status_code=500, detail=str(e))


@agents.router.get("/subscriptions/health")
async def subscriptions_health():
    """Boot-time login-health check: 1-token probe per ACTIVE subscription lane, reporting only
    definitive auth-death (the silent credential-rot class). `skipped` when the router isn't up yet
    so the frontend can retry once instead of reading 'all healthy' off a cold boot."""
    from backend.apps.nine_router import is_running, get_providers
    from backend.apps.nine_router.subscription_health import probe_subscription_health
    from backend.apps.agents.core.bundled_cli_missing import bundled_cli_missing
    # Independent of the router: the bundled-CLI integrity check rides the same boot fetch so an AV-quarantined runtime surfaces as a pill instead of dead turns.
    p_gone = bundled_cli_missing()
    p_heal = None
    if p_gone is not None:
        # Try to put it back before telling anyone it is broken. Detection alone left 22 of 25
        # installs dead, because the fix we named is one almost no user can perform (ENG-422).
        from backend.apps.agents.core.cli_self_heal import repair_bundled_cli
        try:
            p_result = repair_bundled_cli(p_gone)
            p_heal = p_result.detail
            if p_result.repaired and not p_result.retaken:
                p_gone = bundled_cli_missing()
        except Exception:
            logger.exception("bundled-CLI self-heal failed; leaving the card standing")
    p_cli_missing = p_gone is not None
    if not is_running():
        return {"dead": [], "skipped": True, "cli_missing": p_cli_missing, "cli_repair": p_heal}
    try:
        connections = await get_providers()
        dead = await probe_subscription_health(connections)
        return {"dead": dead, "skipped": False, "cli_missing": p_cli_missing, "cli_repair": p_heal}
    except Exception as e:
        logger.debug(f"subscription health probe failed: {e}")
        return {"dead": [], "skipped": True, "cli_missing": p_cli_missing, "cli_repair": p_heal}


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
    import time as p_time
    short_name = (body or {}).get("model") or ""
    if not short_name:
        return {"ok": False, "error": "model required"}
    try:
        from backend.apps.agents.providers.registry import (
            resolve_model_id_for_sdk,
            get_api_type,
            find_builtin_model,
            NINEROUTER_MODEL_PREFIXES,
        )
        from backend.apps.settings.settings import load_settings
        from backend.apps.nine_router import is_running as p_9r_running
        settings = load_settings()
        api_type = get_api_type(short_name)
        resolved = resolve_model_id_for_sdk(short_name, settings)
        entry = find_builtin_model(short_name) or {}
        route = entry.get("route")
        connection_mode = getattr(settings, "connection_mode", "own_key")

        import anthropic
        client = None

        from backend.apps.settings.credentials import own_key_anthropic_client as p_own_key_client
        # Routing mirrors agent_manager: prefix takes precedence over Pro.
        resolved_is_9router = (
            isinstance(resolved, str)
            and resolved.startswith(NINEROUTER_MODEL_PREFIXES)
        )

        if resolved_is_9router:
            if not p_9r_running():
                return {"ok": True, "skipped": True}
            client = anthropic.AsyncAnthropic(api_key="9router", base_url="http://localhost:20128")
        elif route == "api" and api_type == "anthropic" and getattr(settings, "anthropic_api_key", None):
            client = p_own_key_client(settings)
        elif api_type == "anthropic" and connection_mode == "openswarm-pro":
            bearer = getattr(settings, "openswarm_bearer_token", "") or ""
            proxy_url = (getattr(settings, "openswarm_proxy_url", None) or "https://api.openswarm.com").rstrip("/")
            if not bearer:
                return {"ok": True, "skipped": True}
            client = anthropic.AsyncAnthropic(auth_token=bearer, base_url=proxy_url)
        elif api_type == "anthropic" and getattr(settings, "anthropic_api_key", None):
            client = p_own_key_client(settings)
        else:
            if not p_9r_running():
                return {"ok": True, "skipped": True}
            client = anthropic.AsyncAnthropic(api_key="9router", base_url="http://localhost:20128")

        t0 = p_time.monotonic()
        await client.messages.create(
            model=resolved,
            max_tokens=1,
            messages=[{"role": "user", "content": "ping"}],
            timeout=10.0,
        )
        return {"ok": True, "latency_ms": int((p_time.monotonic() - t0) * 1000)}
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
    from backend.apps.nine_router import is_running as p_9r_running, get_providers as p_9r_providers
    from backend.apps.settings.settings import load_settings

    settings = load_settings()
    nine_router_up = p_9r_running()

    connected: set[str] = set()
    if nine_router_up:
        try:
            conns = await p_9r_providers()
            raw_providers = {c.get("provider", "") for c in conns if c.get("isActive") or c.get("testStatus") == "active"}
            # 9Router uses "claude"; our models use api="anthropic". Map across.
            p_9R_TO_API = {
                "claude": "anthropic",
                "codex": "codex",
                "gemini-cli": "gemini-cli",
                "antigravity": "gemini-cli",  # AG = same Gemini models, separate OAuth.
            }
            connected = raw_providers | {p_9R_TO_API.get(p, p) for p in raw_providers}
        except Exception as e:
            logger.debug(f"Failed to fetch 9Router providers: {e}")

    def p_serialize(models: list[dict]) -> list[dict]:
        # Tiers describe the model; billing_kind describes the wallet. Pricing shown only for paid.
        from backend.apps.agents.providers.registry import (
            COST_PER_1M_TOKENS,
            compute_tiers,
            compute_billing_kind,
        )
        out = []
        for m in models:
            input_cost = output_cost = 0.0
            for (p_p, p_v), rates in COST_PER_1M_TOKENS.items():
                if p_v == m["value"]:
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
        result["OpenSwarm Pro"] = p_serialize(adaptive)
        anth_alternates: list[dict] = []
        if has_claude_sub:
            anth_alternates += cc_variants
        if has_api_key:
            anth_alternates += api_variants
        if anth_alternates:
            result["Anthropic"] = p_serialize(anth_alternates)
    elif has_api_key or has_claude_sub:
        rows = p_serialize(adaptive)
        # When an Anthropic key is set, these adaptive rows run on it: own-key routing prefers the user's key over any sub (agent_manager + anthropic_proxy._pick_upstream), so it holds even with a Claude sub connected. Label + bucket as API key (not 9router-state dependent).
        if has_api_key:
            for r in rows:
                if not r["label"].endswith("(API key)"):
                    r["label"] += " (API key)"
                r["billing_kind"] = "api_key"
                r["is_free"] = False
            # Models that only exist on the API-key route have no adaptive twin to relabel, so add them or they vanish.
            adaptive_ids = {m.get("model_id") for m in adaptive}
            api_only = [m for m in api_variants if m.get("model_id") not in adaptive_ids]
            rows = p_serialize(api_only) + rows
        elif has_claude_sub:
            # Only a sub: the adaptive rows route through 9router's cc/ lane, so they're covered by the subscription, not pay-per-use.
            for r in rows:
                r["billing_kind"] = "subscription"
            # Sub-only models with no adaptive twin won't ride the relabeled rows, so add their cc/ entry.
            adaptive_ids = {m.get("model_id") for m in adaptive}
            cc_only = [m for m in cc_variants if m.get("model_id") not in adaptive_ids]
            rows = p_serialize(cc_only) + rows
        # With BOTH a key and a sub the adaptive rows above run on the key, so also surface the subscription (cc) variants; they route via 9router's cc/ lane and stay selectable, the way OpenAI/Gemini show both a subscription row and an API-key row.
        if has_api_key and has_claude_sub:
            rows += p_serialize(cc_variants)
        result["Anthropic"] = rows

    has_openai_key = bool(getattr(settings, "openai_api_key", None))
    has_google_key = bool(getattr(settings, "google_api_key", None))
    has_openrouter_key = bool(getattr(settings, "openrouter_api_key", None))
    from backend.apps.agents.providers.registry import (
        COST_PER_1M_TOKENS as P_CPM,
        compute_tiers as p_ct_native,
        compute_billing_kind as p_cbk_native,
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
            for (p_p, p_v), rates in P_CPM.items():
                if p_v == m["value"]:
                    in_cost, out_cost = rates
                    break
            billing_kind = p_cbk_native(
                api=api, route=route, is_or_free=False, settings=settings,
            )
            tiers = p_ct_native(
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

    # Availability answers "can you use this right now"; the CATALOG answers "does this model still exist".
    # Only the second one may retire a user's pinned model, or a router bounce silently moves their chat to another vendor (ENG-386).
    p_catalog: list[str] = [
        m["value"] for p_models in BUILTIN_MODELS.values() for m in p_models if m.get("value")
    ]
    p_catalog_complete = True

    # Fetch OpenRouter catalog directly (independent of 9Router) so picker fills the moment a key lands.
    or_models: list[dict] = []
    if has_openrouter_key:
        try:
            from backend.apps.agents.providers.registry import fetch_openrouter_models
            or_models = await fetch_openrouter_models(settings.openrouter_api_key)
        except Exception as e:
            logger.debug(f"OpenRouter catalog fetch failed: {e}")
            or_models = []
        # A key we could not enumerate means we cannot vouch for the catalog, so nothing may be retired from it this tick.
        if not or_models:
            p_catalog_complete = False
        p_catalog += [m["value"] for m in or_models if m.get("value")]
        if or_models:
            by_vendor: dict[str, list[dict]] = {}
            from backend.apps.agents.providers.registry import (
                compute_tiers as p_ct,
                compute_billing_kind as p_cbk,
            )
            for m in or_models:
                v = m.get("vendor") or "Other"
                in_cost = float(m.get("input_cost_per_1m", 0.0))
                out_cost = float(m.get("output_cost_per_1m", 0.0))
                is_free = bool(m.get("is_free", False))
                billing_kind = p_cbk(
                    api="openrouter", route="openrouter", is_or_free=is_free,
                    settings=settings,
                )
                tiers = p_ct(
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
    from backend.apps.agents.providers.registry import custom_provider_slug_for_lookup
    for cp in (getattr(settings, "custom_providers", None) or []):
        cp_name = (getattr(cp, "name", "") or "").strip()
        cp_base_url = (getattr(cp, "base_url", "") or "").strip()
        cp_models = getattr(cp, "models", None) or []
        if not cp_name or not cp_base_url or not cp_models:
            continue
        slug = custom_provider_slug_for_lookup(cp_name)
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
        p_catalog += [e["value"] for e in entries]
        if entries:
            result[cp_name] = entries

    # Free lane: nothing of the user's own is connected, so surface the funded Haiku as the free-trial face. The picker shows "Claude Haiku" and the session/default reconcile to it, instead of the picker going empty and the model staying stuck on a dead last-used id (active = it runs; spent = the send is gated by the out-of-runs UI).
    if not result:
        haiku_entry = next((m for m in anthropic_models if m.get("value") == "haiku"), None)
        if haiku_entry:
            haiku_rows = p_serialize([haiku_entry])
            for hr in haiku_rows:
                hr["is_free"] = True
                hr["billing_kind"] = "free"
            result["Anthropic"] = haiku_rows

    return {
        "models": result,
        "notes": notes,
        "known_values": sorted(set(p_catalog)),
        "catalog_complete": p_catalog_complete,
    }


@agents.router.post("/subscriptions/disconnect")
async def subscriptions_disconnect(body: dict):
    """Disconnect a subscription provider's 9Router lane; reports ok only once the lane is verifiably gone."""
    from backend.apps.agents.disconnect_subscription import disconnect_subscription
    provider = body.get("provider", "")
    if not provider:
        raise HTTPException(status_code=400, detail="provider required")
    result = await disconnect_subscription(provider)
    return result.model_dump()
