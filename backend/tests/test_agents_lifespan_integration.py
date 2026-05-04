"""Integration tests for `backend.apps.agents.agents` (router + lifespan).

Existing `test_api_agents.py` covers the happy paths of each REST
endpoint. This file fills in branches that those don't:

  - `agents_lifespan` startup runs `reconcile_on_startup` +
    `restore_all_sessions`; shutdown stops in-flight tasks +
    persists every active session.
  - `POST /sessions/{sid}/message` schedules `mcp_preflight.run_preflight`
    in a background task; with patched run_preflight returning
    suggestions we observe the `agent:mcp_suggestions` event reach
    `ws_manager`.
  - Preflight raising → message still returns 200 (fail-open contract).
  - `POST /sessions/{sid}/warm-cache` returns 200 even if the manager
    raises, and is wired to `agent_manager.warm_prompt_cache`.
  - `GET /api/agents/models` four logical branches:
      a) no creds + no 9Router → empty Anthropic block
      b) anthropic_api_key only → Anthropic group emitted
      c) openswarm-pro + claude sub → both "OpenSwarm Pro" and
         "Anthropic" groups
      d) openswarm-pro alone → only "OpenSwarm Pro"
"""

from __future__ import annotations

import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.apps.agents import agents as agents_mod
from backend.apps.agents.agent_manager import (
    _save_session,
    agent_manager,
)
from backend.apps.agents.models import AgentSession


# ---------------------------------------------------------------------------
# agents_lifespan startup + shutdown
# ---------------------------------------------------------------------------


async def test_agents_lifespan_startup_runs_reconcile_and_restore(tmp_data_dirs):
    """Drop a stale-running session on disk, drive lifespan, assert the
    session was reconciled (status flipped to stopped) AND restored
    into memory (closed_at=None on disk record)."""
    _save_session("active-startup", {
        "id": "active-startup", "name": "alive", "model": "sonnet",
        "mode": "agent", "status": "running", "messages": [],
        "closed_at": None,
    })

    # Reset in-memory state so the lifespan's restore is observable
    agent_manager.sessions.clear()
    agent_manager.tasks.clear()

    async with agents_mod.agents_lifespan():
        # Inside the lifespan: session is restored into memory and
        # status was reconciled to stopped (since we marked it running).
        assert "active-startup" in agent_manager.sessions
        assert agent_manager.sessions["active-startup"].status == "stopped"


async def test_agents_lifespan_shutdown_stops_running_tasks_and_persists(tmp_data_dirs):
    """Plant an in-flight task in the manager, drive shutdown, assert
    the task is cancelled and the session is persisted to disk."""
    agent_manager.sessions.clear()
    agent_manager.tasks.clear()

    sess = AgentSession(name="ToShutdown", model="sonnet")
    agent_manager.sessions[sess.id] = sess

    async def _hang():
        await asyncio.Event().wait()

    task = asyncio.create_task(_hang())
    agent_manager.tasks[sess.id] = task

    try:
        async with agents_mod.agents_lifespan():
            pass
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    # After shutdown: in-memory clear + persisted to disk.
    assert sess.id not in agent_manager.sessions
    from backend.apps.agents.agent_manager import _load_session_data
    data = _load_session_data(sess.id)
    assert data is not None
    assert data["status"] == "stopped"


# ---------------------------------------------------------------------------
# POST /sessions/{sid}/message — preflight branch
# ---------------------------------------------------------------------------


async def _drain_pending_tasks(loop_iters: int = 5) -> None:
    """Yield to the event loop a few times so a fire-and-forget
    `asyncio.create_task(_emit_preflight())` finishes before we assert."""
    for _ in range(loop_iters):
        await asyncio.sleep(0)


def test_send_message_fires_preflight_emits_mcp_suggestions(client, stub_agent_loop):
    """Patched run_preflight returns suggestions → `ws_manager` should
    see an `agent:mcp_suggestions` event sent to the session."""
    captured: list[tuple[str, str, dict]] = []

    async def _capture_send(session_id: str, event: str, payload: dict):
        captured.append((session_id, event, payload))

    suggestions = [{
        "id": "Slack", "title": "Slack", "description": "x",
        "reason": "user mentioned channel",
    }]

    # Launch a session first so message has something to land on.
    r = client.post("/api/agents/launch", json={
        "name": "test", "model": "sonnet", "mode": "agent",
    })
    assert r.status_code == 200
    sid = r.json()["session_id"]

    async def _fake_preflight(prompt: str, timeout_s: float = 2.0):
        return {"is_vague": True, "suggestions": suggestions}

    # The send_message handler does `from .ws_manager import ws_manager as _ws`
    # at call time, so we have to patch the source module's attribute, not
    # the alias on `agents_mod`.
    from backend.apps.agents import ws_manager as _ws_mod

    fake_ws = MagicMock()
    fake_ws.send_to_session = AsyncMock(side_effect=_capture_send)

    with patch.object(_ws_mod, "ws_manager", fake_ws), \
         patch("backend.apps.agents.mcp_preflight.run_preflight", _fake_preflight):
        r = client.post(f"/api/agents/sessions/{sid}/message",
                        json={"prompt": "send an update to the team channel"})
        assert r.status_code == 200

        # The preflight emit is fired in a background task. Drain by
        # giving the event loop time to run pending tasks. TestClient's
        # `requests`-shaped surface returns synchronously after the
        # endpoint coroutine completes, so the background task may not
        # have run yet — but the FastAPI/Starlette runner shares its
        # loop across consecutive sync calls. A second tiny request
        # forces a loop step.
        for _ in range(10):
            client.get("/api/health")
            if captured:
                break

    suggestion_events = [c for c in captured if c[1] == "agent:mcp_suggestions"]
    assert len(suggestion_events) >= 1
    payload = suggestion_events[0][2]
    assert payload["is_vague"] is True
    assert payload["suggestions"] == suggestions


def test_send_message_preflight_raises_still_returns_ok(client, stub_agent_loop):
    """Preflight is best-effort: any exception inside the classifier
    must be swallowed so the agent still proceeds."""
    r = client.post("/api/agents/launch", json={
        "name": "fail-open", "model": "sonnet", "mode": "agent",
    })
    sid = r.json()["session_id"]

    async def _broken_preflight(prompt, timeout_s=2.0):
        raise RuntimeError("preflight kaboom")

    with patch("backend.apps.agents.mcp_preflight.run_preflight", _broken_preflight):
        r = client.post(f"/api/agents/sessions/{sid}/message",
                        json={"prompt": "do the thing"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


# ---------------------------------------------------------------------------
# POST /sessions/{sid}/warm-cache
# ---------------------------------------------------------------------------


def test_warm_cache_calls_agent_manager(client):
    """Endpoint should invoke `agent_manager.warm_prompt_cache(session_id)`."""
    called: list[str] = []

    async def _fake_warm(session_id: str):
        called.append(session_id)

    with patch.object(agent_manager, "warm_prompt_cache", side_effect=_fake_warm):
        r = client.post("/api/agents/sessions/sess-x/warm-cache")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert called == ["sess-x"]


def test_warm_cache_swallows_manager_exceptions(client):
    """Best-effort: an exception from warm_prompt_cache must NOT bubble."""
    async def _explode(session_id: str):
        raise RuntimeError("kaboom")

    with patch.object(agent_manager, "warm_prompt_cache", side_effect=_explode):
        r = client.post("/api/agents/sessions/sess-x/warm-cache")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


# ---------------------------------------------------------------------------
# GET /api/agents/models
# ---------------------------------------------------------------------------


def _patch_settings(monkeypatch, **overrides):
    """Override `load_settings` returns to a tweaked AppSettings."""
    from backend.apps.settings.models import AppSettings
    s = AppSettings(**overrides)
    monkeypatch.setattr("backend.apps.settings.settings.load_settings",
                        lambda: s)


def _patch_9router(monkeypatch, *, running: bool, providers: list[dict]):
    monkeypatch.setattr("backend.apps.nine_router.is_running", lambda: running)

    async def _fake_get_providers():
        return providers

    monkeypatch.setattr("backend.apps.nine_router.get_providers", _fake_get_providers)


def test_models_no_creds_no_9router_returns_empty_anthropic(client, monkeypatch):
    """No api keys, no 9Router → no Anthropic group at all (own_key
    branch only emits when has_api_key OR has_claude_sub)."""
    _patch_settings(monkeypatch)
    _patch_9router(monkeypatch, running=False, providers=[])
    r = client.get("/api/agents/models")
    assert r.status_code == 200
    models = r.json()["models"]
    assert "Anthropic" not in models
    assert "OpenSwarm Pro" not in models


def test_models_anthropic_api_key_only(client, monkeypatch):
    """anthropic_api_key set, own_key mode → adaptive Anthropic group
    surfaces under 'Anthropic'."""
    _patch_settings(monkeypatch, anthropic_api_key="sk-test")
    _patch_9router(monkeypatch, running=False, providers=[])
    r = client.get("/api/agents/models")
    models = r.json()["models"]
    assert "Anthropic" in models
    assert any(m["value"] == "sonnet" for m in models["Anthropic"])
    assert "OpenSwarm Pro" not in models


def test_models_openswarm_pro_only(client, monkeypatch):
    """openswarm-pro + bearer, no claude sub → only 'OpenSwarm Pro' group."""
    _patch_settings(monkeypatch,
                    connection_mode="openswarm-pro",
                    openswarm_bearer_token="bearer-x")
    _patch_9router(monkeypatch, running=False, providers=[])
    r = client.get("/api/agents/models")
    models = r.json()["models"]
    assert "OpenSwarm Pro" in models
    assert "Anthropic" not in models
    # Adaptive variants only (no -cc / -api suffix)
    values = {m["value"] for m in models["OpenSwarm Pro"]}
    assert "sonnet" in values
    assert "sonnet-cc" not in values
    assert "sonnet-api" not in values


def test_models_openswarm_pro_plus_claude_sub_emits_both(client, monkeypatch):
    """openswarm-pro + 9Router claude sub → BOTH 'OpenSwarm Pro' (adaptive)
    AND 'Anthropic' (-cc variants for personal sub routing)."""
    _patch_settings(monkeypatch,
                    connection_mode="openswarm-pro",
                    openswarm_bearer_token="bearer-x")
    _patch_9router(monkeypatch, running=True,
                   providers=[{"provider": "claude", "isActive": True}])
    r = client.get("/api/agents/models")
    models = r.json()["models"]
    assert "OpenSwarm Pro" in models
    assert "Anthropic" in models
    # The Anthropic group uses -cc variants
    cc_values = {m["value"] for m in models["Anthropic"]}
    assert "sonnet-cc" in cc_values


def test_models_subscription_only_models_gated_by_9router(client, monkeypatch):
    """OpenAI/Codex models are subscription_only — they only surface
    when 9Router has the codex provider connected."""
    _patch_settings(monkeypatch, anthropic_api_key="sk-test")
    _patch_9router(monkeypatch, running=True,
                   providers=[{"provider": "codex", "isActive": True}])
    r = client.get("/api/agents/models")
    models = r.json()["models"]
    assert "OpenAI" in models
    assert any(m["value"] == "gpt-5.4" for m in models["OpenAI"])


def test_models_openai_api_key_surfaces_pinned_api_variants(client, monkeypatch):
    """openai_api_key set → -api variants surface under 'OpenAI' group
    even without a Codex subscription."""
    _patch_settings(monkeypatch,
                    anthropic_api_key="sk-test",
                    openai_api_key="sk-openai")
    _patch_9router(monkeypatch, running=False, providers=[])
    r = client.get("/api/agents/models")
    models = r.json()["models"]
    assert "OpenAI" in models
    values = {m["value"] for m in models["OpenAI"]}
    assert "gpt-5.4-api" in values
    assert "gpt-5.4" not in values  # subscription one is hidden


def test_models_google_api_key_surfaces_pinned_api_variants(client, monkeypatch):
    _patch_settings(monkeypatch,
                    anthropic_api_key="sk-test",
                    google_api_key="AIza-test")
    _patch_9router(monkeypatch, running=False, providers=[])
    r = client.get("/api/agents/models")
    models = r.json()["models"]
    assert "Google" in models
    values = {m["value"] for m in models["Google"]}
    assert "gemini-3-pro-api" in values
    assert "gemini-3-pro" not in values  # subscription-only hidden


def test_models_response_shape_includes_reasoning_and_context(client, monkeypatch):
    _patch_settings(monkeypatch, anthropic_api_key="sk-test")
    _patch_9router(monkeypatch, running=False, providers=[])
    r = client.get("/api/agents/models")
    body = r.json()
    assert "models" in body and "notes" in body
    sonnet = next(m for m in body["models"]["Anthropic"] if m["value"] == "sonnet")
    assert sonnet["context_window"] == 1_000_000
    assert sonnet["reasoning"] is True
    assert "label" in sonnet


def test_models_9router_provider_fetch_failure_falls_back_to_unconnected(client, monkeypatch):
    """If 9Router probe raises, log + treat as no providers connected."""
    _patch_settings(monkeypatch,
                    connection_mode="openswarm-pro",
                    openswarm_bearer_token="bearer-x")

    monkeypatch.setattr("backend.apps.nine_router.is_running", lambda: True)

    async def _broken_get_providers():
        raise RuntimeError("9Router exploded")

    monkeypatch.setattr("backend.apps.nine_router.get_providers", _broken_get_providers)

    r = client.get("/api/agents/models")
    models = r.json()["models"]
    # Only the Pro group remains (claude sub treated as missing).
    assert "OpenSwarm Pro" in models
    assert "Anthropic" not in models


# ---------------------------------------------------------------------------
# Smoke: existing endpoints still work
# ---------------------------------------------------------------------------


def test_warm_cache_unknown_session_still_returns_ok(client):
    """warm-cache is best-effort. Even if the session doesn't exist
    (manager will raise ValueError), the endpoint returns 200."""
    r = client.post("/api/agents/sessions/does-not-exist/warm-cache")
    assert r.status_code == 200
