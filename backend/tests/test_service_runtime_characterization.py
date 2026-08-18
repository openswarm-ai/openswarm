"""Characterization tests for the service app's cross-app runtime behavior.

Pins the CURRENT observable behavior of service/service.py's settings,
nine_router, and agent_manager touchpoints before lazy-import batch 5
moves them behind an injected runtime boundary: first-open stamping and
the startup sync envelopes, 9Router autostart/stop lifecycle, and the
usage-summary / cost-breakdown routes. Seams (module attributes on
nine_router and agent_manager, the settings file, the svc test sink)
must keep working identically after the refactor.

Coverage boundary, stated on purpose: the minute-cadence pulse loop's
port usage cannot be driven from tests without touching p_ internals
(it sleeps 60s before its first sample and was never unit-covered);
its wiring is pinned by the AST no-lazy-import assertion plus the same
default adapters the routes exercise.

Run:
    python -m pytest backend/tests/test_service_runtime_characterization.py -v
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import backend.apps.agents.agent_manager as agent_manager_module
import backend.apps.nine_router as nine_router
import backend.apps.service.client as svc_client
import backend.apps.service.service as service_module
import backend.apps.settings.store as settings_store


class FakeLiveSession:
    def __init__(self, payload):
        self.payload = payload

    def model_dump(self, mode="json"):
        return dict(self.payload)


class FakeAgentManager:
    def __init__(self):
        self.sessions = {}
        self.dumped = []

    def get_all_sessions(self):
        return list(self.dumped)


def real_session(sid, cost=0.0, messages=(), status="completed", **extra):
    return {
        "id": sid,
        "cost_usd": cost,
        "messages": list(messages),
        "model": "sonnet",
        "provider": "anthropic",
        "status": status,
        "tokens": {"input": 0, "output": 0},
        **extra,
    }


@pytest.fixture
def env(tmp_path, monkeypatch):
    sf = tmp_path / "settings.json"
    sf.write_text("{}")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", str(sf))
    settings_store.p_cached_settings = None
    settings_store.p_cached_sig = None

    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    monkeypatch.setattr(service_module, "SESSIONS_DIR", str(sessions_dir))

    captured = []
    svc_client.install_id = None
    svc_client.p_user_id = None
    svc_client.set_test_sink(lambda kind, body: captured.append(body["d"]))

    calls = SimpleNamespace(ensure=0, stop=0, stats_periods=[], running=False, stats=None)

    async def fake_stats(period="all"):
        calls.stats_periods.append(period)
        return calls.stats

    async def fake_ensure():
        calls.ensure += 1

    def fake_stop():
        calls.stop += 1
    monkeypatch.setattr(nine_router, "is_running", lambda: calls.running)
    monkeypatch.setattr(nine_router, "get_usage_stats", fake_stats)
    monkeypatch.setattr(nine_router, "ensure_running", fake_ensure)
    monkeypatch.setattr(nine_router, "stop", fake_stop)

    manager = FakeAgentManager()
    monkeypatch.setattr(agent_manager_module, "agent_manager", manager)
    monkeypatch.setenv("OPENSWARM_DISABLE_9ROUTER_AUTOSTART", "1")

    app = FastAPI()
    app.include_router(service_module.service.router, prefix="/api/service")
    yield SimpleNamespace(
        app=app, settings_file=sf, sessions_dir=sessions_dir, captured=captured,
        calls=calls, manager=manager, monkeypatch=monkeypatch,
    )
    svc_client.test_sink = None
    svc_client.install_id = None
    svc_client.p_user_id = None
    settings_store.p_cached_settings = None
    settings_store.p_cached_sig = None


def run_lifespan(env):
    async def go():
        async with service_module.service_lifespan():
            pass
    asyncio.run(go())


def request(app, method, path):
    async def go():
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path)
    return asyncio.run(go())


def startup_envelopes(env):
    plain = [d for d in env.captured if "identity" not in d]
    identity = [d for d in env.captured if "identity" in d]
    return plain, identity


# --- lifespan: first-open + startup envelopes ---------------------------------

def test_first_open_is_stamped_and_persisted(env):
    run_lifespan(env)
    on_disk = json.loads(env.settings_file.read_text())
    assert on_disk["first_opened_at"]
    plain, identity = startup_envelopes(env)
    assert plain and plain[0]["is_first_open"] is True
    assert identity, "identity envelope must be sent"


def test_second_boot_is_not_first_open(env):
    env.settings_file.write_text(json.dumps({"first_opened_at": "2026-07-01T00:00:00"}))
    run_lifespan(env)
    plain, _ = startup_envelopes(env)
    assert plain[0]["is_first_open"] is False
    assert plain[0]["days_since_install"] >= 0
    assert json.loads(env.settings_file.read_text())["first_opened_at"] == "2026-07-01T00:00:00"


def test_configured_providers_are_enumerated(env):
    env.settings_file.write_text(json.dumps({
        "first_opened_at": "2026-07-01T00:00:00",
        "anthropic_api_key": "k1",
        "openai_api_key": "k2",
    }))
    run_lifespan(env)
    plain, identity = startup_envelopes(env)
    assert plain[0]["providers"] == ["anthropic", "openai"]
    assert plain[0]["provider_count"] == 2
    assert identity[0]["identity"]["is_paying_customer"] is False
    assert identity[0]["identity"]["plan"] == "free"


# --- lifespan: 9Router autostart / stop ---------------------------------------

def test_autostart_runs_router_and_stop_fires_on_exit(env):
    env.monkeypatch.delenv("OPENSWARM_DISABLE_9ROUTER_AUTOSTART", raising=False)
    run_lifespan(env)
    assert env.calls.ensure == 1
    assert env.calls.stop == 1


def test_disabled_autostart_skips_router_but_still_stops(env):
    run_lifespan(env)
    assert env.calls.ensure == 0
    assert env.calls.stop == 1


# --- usage-summary route ------------------------------------------------------

def test_usage_summary_merges_disk_and_live_sessions_offline(env):
    disk = real_session("d-1", cost=2.5, messages=[{"role": "assistant", "content": "hi"}])
    (env.sessions_dir / "d-1.json").write_text(json.dumps(disk))
    draft = real_session("d-2", cost=0.0)
    (env.sessions_dir / "d-2.json").write_text(json.dumps(draft))
    env.manager.dumped = [FakeLiveSession(real_session(
        "l-1", cost=0.5, messages=[{"role": "assistant", "content": "yo"}],
    ))]

    body = request(env.app, "GET", "/api/service/usage-summary").json()
    assert body["total_sessions"] == 2
    assert body["total_cost_usd"] == 3.0
    assert body["cost_source"] == "sdk"
    assert body["nine_router_available"] is False


def test_usage_summary_prefers_nine_router_cost(env):
    env.calls.running = True
    env.calls.stats = {
        "totalCost": 9.9, "totalPromptTokens": 111, "totalCompletionTokens": 222,
        "totalRequests": 33,
        "byModel": {"m1": {"cost": 9.9, "count": 33, "promptTokens": 111, "completionTokens": 222}},
        "byProvider": {"p1": {"cost": 9.9, "count": 33}},
    }
    body = request(env.app, "GET", "/api/service/usage-summary").json()
    assert body["cost_source"] == "9router"
    assert body["total_cost_usd"] == 9.9
    assert body["total_prompt_tokens"] == 111
    assert body["total_requests"] == 33
    assert body["nine_router_available"] is True
    assert body["cost_by_model"]["m1"]["requests"] == 33
    assert env.calls.stats_periods == ["all"]


# --- cost-breakdown route -----------------------------------------------------

def test_cost_breakdown_unavailable_when_router_down(env):
    body = request(env.app, "GET", "/api/service/cost-breakdown?period=30d").json()
    assert body == {"available": False, "by_model": {}, "by_provider": {}}
    assert env.calls.stats_periods == []


def test_cost_breakdown_maps_stats_and_passes_period(env):
    env.calls.running = True
    env.calls.stats = {
        "totalCost": 4.2, "totalRequests": 7, "totalPromptTokens": 70,
        "totalCompletionTokens": 71, "byModel": {"m": {}}, "byProvider": {"p": {}},
    }
    body = request(env.app, "GET", "/api/service/cost-breakdown?period=30d").json()
    assert body["available"] is True
    assert body["period"] == "30d"
    assert body["total_cost"] == 4.2
    assert body["by_model"] == {"m": {}}
    assert env.calls.stats_periods == ["30d"]


def test_cost_breakdown_unavailable_when_stats_empty(env):
    env.calls.running = True
    env.calls.stats = None
    body = request(env.app, "GET", "/api/service/cost-breakdown").json()
    assert body == {"available": False, "by_model": {}, "by_provider": {}}
