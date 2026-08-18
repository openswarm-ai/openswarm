"""Contract tests for the service app's injected runtime boundary.

Proves the lazy-import batch 5 inversion through public surface only:
service.py's routes and lifespan consult the injected RouterUsage /
AgentCensus ports (and the batch-3 SettingsGateway for first-open),
injected fakes fully control behavior while the sibling apps are patched
to reject any access, and the lazy sibling imports cannot silently
return to either owned file.

Run:
    python -m pytest backend/tests/test_service_runtime_port.py -v
"""

from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import backend.apps.agents.agent_manager as agent_manager_module
import backend.apps.nine_router as nine_router
import backend.apps.service.client as svc_client
import backend.apps.service.service as service_module
import backend.apps.service.settings_gateway as settings_gateway_module
from backend.apps.service.service_runtime import (
    AgentCensus,
    DefaultAgentCensus,
    DefaultRouterUsage,
    RouterUsage,
)
from backend.apps.settings.models import AppSettings

import backend.apps.service.service_runtime as service_runtime_module


class FakeRouterUsage:
    def __init__(self, running=False, stats=None):
        self.running = running
        self.stats = stats
        self.ensured = 0
        self.stopped = 0
        self.periods = []

    def is_running(self):
        return self.running

    async def get_usage_stats(self, period="all"):
        self.periods.append(period)
        return self.stats

    async def ensure_running(self):
        self.ensured += 1

    def stop(self):
        self.stopped += 1


class FakeAgentCensus:
    def __init__(self, count=0, sessions=()):
        self.count = count
        self.sessions_list = list(sessions)

    def live_session_count(self):
        return self.count

    def all_sessions(self):
        return self.sessions_list


class FakeSettingsGateway:
    def __init__(self, settings):
        self.settings = settings
        self.saved = []

    def load(self):
        return self.settings

    def save(self, settings):
        self.saved.append(settings)

    def default_proxy_url(self):
        return "https://gateway-default.example.com"


class FakeLiveSession:
    def __init__(self, payload):
        self.payload = payload

    def model_dump(self, mode="json"):
        return dict(self.payload)


@pytest.fixture
def env(tmp_path, monkeypatch):
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    monkeypatch.setattr(service_module, "SESSIONS_DIR", str(sessions_dir))

    def deny(*args, **kwargs):
        raise AssertionError("sibling app must not be touched when ports are injected")
    monkeypatch.setattr(nine_router, "is_running", deny)
    monkeypatch.setattr(nine_router, "get_usage_stats", deny)
    monkeypatch.setattr(nine_router, "ensure_running", deny)
    monkeypatch.setattr(nine_router, "stop", deny)
    monkeypatch.setattr(agent_manager_module, "agent_manager", None)

    router = FakeRouterUsage()
    census = FakeAgentCensus()
    gateway = FakeSettingsGateway(AppSettings(first_opened_at="2026-07-01T00:00:00"))
    monkeypatch.setattr(service_runtime_module, "DEFAULT_ROUTER_USAGE", router)
    monkeypatch.setattr(service_runtime_module, "DEFAULT_AGENT_CENSUS", census)
    monkeypatch.setattr(settings_gateway_module, "DEFAULT_SETTINGS_GATEWAY", gateway)

    captured = []
    svc_client.install_id = None
    svc_client.p_user_id = None
    svc_client.set_test_sink(lambda kind, body: captured.append(body["d"]))
    monkeypatch.setenv("OPENSWARM_DISABLE_9ROUTER_AUTOSTART", "1")

    app = FastAPI()
    app.include_router(service_module.service.router, prefix="/api/service")
    yield SimpleNamespace(
        app=app, router=router, census=census, gateway=gateway,
        captured=captured, sessions_dir=sessions_dir, monkeypatch=monkeypatch,
    )
    svc_client.test_sink = None
    svc_client.install_id = None
    svc_client.p_user_id = None


def run_lifespan():
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


# --- port conformance ---------------------------------------------------------

def test_default_adapters_conform_to_protocols():
    assert isinstance(DefaultRouterUsage(), RouterUsage)
    assert isinstance(DefaultAgentCensus(), AgentCensus)


def test_fakes_conform_to_protocols():
    assert isinstance(FakeRouterUsage(), RouterUsage)
    assert isinstance(FakeAgentCensus(), AgentCensus)


# --- routes consume only the injected ports -----------------------------------

def test_usage_summary_reads_injected_census_and_router(env):
    env.census.sessions_list = [FakeLiveSession({
        "id": "l-1", "cost_usd": 1.5,
        "messages": [{"role": "assistant", "content": "hi"}],
        "model": "sonnet", "provider": "anthropic", "status": "completed",
        "tokens": {"input": 0, "output": 0},
    })]
    body = request(env.app, "GET", "/api/service/usage-summary").json()
    assert body["total_sessions"] == 1
    assert body["cost_source"] == "sdk"
    assert body["nine_router_available"] is False


def test_cost_breakdown_reads_injected_router(env):
    env.router.running = True
    env.router.stats = {"totalCost": 3.3, "totalRequests": 2, "byModel": {}, "byProvider": {}}
    body = request(env.app, "GET", "/api/service/cost-breakdown?period=1d").json()
    assert body["available"] is True
    assert body["total_cost"] == 3.3
    assert env.router.periods == ["1d"]


# --- lifespan consumes only the injected ports --------------------------------

def test_lifespan_first_open_persists_through_injected_gateway(env):
    env.gateway.settings = AppSettings()
    run_lifespan()
    assert env.gateway.saved and env.gateway.saved[0].first_opened_at
    assert env.captured and env.captured[0]["is_first_open"] is True


def test_lifespan_autostart_and_stop_use_injected_router(env):
    env.monkeypatch.delenv("OPENSWARM_DISABLE_9ROUTER_AUTOSTART", raising=False)
    run_lifespan()
    assert env.router.ensured == 1
    assert env.router.stopped == 1


def test_lifespan_disabled_autostart_still_stops_router(env):
    run_lifespan()
    assert env.router.ensured == 0
    assert env.router.stopped == 1


# --- the lazy sibling imports must not come back ------------------------------

def function_local_sibling_imports(module_path: Path) -> list[int]:
    tree = ast.parse(module_path.read_text(encoding="utf-8"))
    offenders: list[int] = []

    def walk(node: ast.AST, in_function: bool) -> None:
        for child in ast.iter_child_nodes(node):
            inner = in_function or isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            if in_function and isinstance(child, (ast.Import, ast.ImportFrom)):
                names = [alias.name for alias in child.names] if isinstance(child, ast.Import) else [child.module or ""]
                if any(
                    name.startswith("backend.apps.") and not name.startswith("backend.apps.service")
                    for name in names
                ):
                    offenders.append(child.lineno)
            walk(child, inner)

    walk(tree, False)
    return offenders


def test_service_module_has_no_function_local_sibling_imports():
    repo = Path(__file__).resolve().parents[2]
    for rel in ("backend/apps/service/service.py", "backend/apps/service/service_runtime.py"):
        assert function_local_sibling_imports(repo / rel) == [], f"{rel} regressed to lazy sibling imports"
