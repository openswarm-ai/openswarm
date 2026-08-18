"""Contract tests for the dashboards app's injected runtime boundary.

Proves the injected runtime boundary through the public surface only: the
dashboard routes and the strip_orphan_session_cards helper consult the
injected SessionAuthority/DashboardTelemetry/AuxNaming ports, injected
fakes fully control behavior while the underlying sibling apps are patched
to reject any access, and the lazy sibling imports cannot silently return.

Run:
    python -m pytest backend/tests/test_dashboard_runtime_port.py -v
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
import backend.apps.agents.manager.session.session_store as session_store_module
import backend.apps.service.analytics.client as analytics_module
from backend.apps.dashboards import dashboard_runtime
from backend.apps.dashboards import dashboards as dashboard_routes
from backend.apps.dashboards.dashboard_runtime import (
    AuxNaming,
    DashboardTelemetry,
    DefaultAuxNaming,
    DefaultDashboardTelemetry,
    DefaultSessionAuthority,
    SessionAuthority,
)
from backend.apps.dashboards.models import Dashboard


class FakeSession:
    def __init__(self, id, dashboard_id):
        self.id = id
        self.dashboard_id = dashboard_id
        self.messages = []
        self.browser_id = None
        self.parent_session_id = None

    def model_dump(self, mode="json"):
        return {"id": self.id, "dashboard_id": self.dashboard_id}


class FakeAuthority:
    def __init__(self, sessions=None, disk=None):
        self.sessions = dict(sessions or {})
        self.disk = dict(disk or {})
        self.deleted = []
        self.saved = []
        self.purged = []

    def live_sessions(self):
        return self.sessions

    def load_session_data(self, session_id):
        return self.disk.get(session_id)

    def save_session(self, session_id, data):
        self.saved.append((session_id, data))

    async def delete_session(self, session_id):
        self.deleted.append(session_id)
        self.sessions.pop(session_id, None)

    async def duplicate_session(self, session_id, *, dashboard_id):
        return FakeSession(f"dup-{session_id}", dashboard_id)

    def purge_session_memory(self, session_id):
        self.purged.append(session_id)


class FakeTelemetry:
    def __init__(self):
        self.events = []

    def dashboard_event(self, *, dashboard_id, action):
        self.events.append((action, dashboard_id))


class FakeNaming:
    """Naming port whose settings load always fails, forcing the fallback path."""

    def load_settings(self):
        raise RuntimeError("settings off limits")

    async def resolve_aux_model(self, settings, *, preferred_tier):
        raise AssertionError("must not be reached after load_settings fails")

    def client_for_model(self, settings, model):
        raise AssertionError("must not be reached")

    def clean_short_label(self, text):
        return text

    def aux_max_tokens_for(self, model):
        return 16


@pytest.fixture
def env(tmp_path, monkeypatch):
    data_dir = tmp_path / "dashboards"
    sessions_dir = tmp_path / "sessions"
    data_dir.mkdir()
    sessions_dir.mkdir()
    monkeypatch.setattr(dashboard_routes, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(dashboard_routes, "SESSIONS_DIR", str(sessions_dir))

    def deny(*args, **kwargs):
        raise AssertionError("sibling app must not be touched when ports are injected")
    monkeypatch.setattr(agent_manager_module, "agent_manager", None)
    monkeypatch.setattr(analytics_module, "track_dashboard_event", deny)
    monkeypatch.setattr(session_store_module, "load_session_data", deny)
    monkeypatch.setattr(session_store_module, "save_session", deny)

    authority = FakeAuthority()
    telemetry = FakeTelemetry()
    monkeypatch.setattr(dashboard_runtime, "DEFAULT_SESSION_AUTHORITY", authority)
    monkeypatch.setattr(dashboard_runtime, "DEFAULT_DASHBOARD_TELEMETRY", telemetry)
    monkeypatch.setattr(dashboard_runtime, "DEFAULT_AUX_NAMING", FakeNaming())

    app = FastAPI()
    app.include_router(dashboard_routes.dashboards.router, prefix="/api/dashboards")
    return SimpleNamespace(app=app, data_dir=data_dir, authority=authority, telemetry=telemetry)


def request(app, method, path, json_payload=None):
    async def go():
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, json=json_payload)
    return asyncio.run(go())


# --- port conformance ---------------------------------------------------------

def test_default_adapters_conform_to_protocols():
    assert isinstance(DefaultSessionAuthority(), SessionAuthority)
    assert isinstance(DefaultDashboardTelemetry(), DashboardTelemetry)
    assert isinstance(DefaultAuxNaming(), AuxNaming)


def test_fakes_conform_to_protocols():
    assert isinstance(FakeAuthority(), SessionAuthority)
    assert isinstance(FakeTelemetry(), DashboardTelemetry)
    assert isinstance(FakeNaming(), AuxNaming)


# --- routes consume only the injected ports -----------------------------------

def test_create_reports_through_injected_telemetry(env):
    response = request(env.app, "POST", "/api/dashboards/create", {"name": "Ported"})
    assert response.status_code == 200
    assert env.telemetry.events == [("create", response.json()["id"])]


def test_delete_uses_injected_authority_and_telemetry(env):
    dashboard_routes.save(Dashboard(id="d1", name="Doomed"))
    env.authority.sessions["mine"] = FakeSession("mine", "d1")
    env.authority.sessions["other"] = FakeSession("other", "d2")

    response = request(env.app, "DELETE", "/api/dashboards/d1")
    assert response.status_code == 200
    assert env.authority.deleted == ["mine"]
    assert "other" in env.authority.sessions
    assert env.telemetry.events == [("delete", "d1")]


def test_duplicate_uses_injected_authority_for_copy_and_save(env):
    dashboard_routes.save(Dashboard(
        id="d1", name="Source",
        layout={"cards": {"s1": {"session_id": "s1"}}, "expanded_session_ids": ["s1"]},
    ))
    env.authority.sessions["s1"] = FakeSession("s1", "d1")

    response = request(env.app, "POST", "/api/dashboards/d1/duplicate")
    assert response.status_code == 200
    body = response.json()
    assert set(body["layout"]["cards"]) == {"dup-s1"}
    assert body["layout"]["expanded_session_ids"] == ["dup-s1"]
    assert [sid for sid, _ in env.authority.saved] == ["dup-s1"]
    assert env.telemetry.events == [("create", body["id"])]


def test_duplicate_rolls_back_copied_sessions_when_the_dashboard_write_fails(env, monkeypatch):
    """The sessions are copied before the new dashboard file is written; if that write fails, the copies must not survive as orphans."""
    dashboard_routes.save(Dashboard(
        id="d1", name="Source",
        layout={"cards": {"s1": {"session_id": "s1"}, "s2": {"session_id": "s2"}}},
    ))
    env.authority.sessions["s1"] = FakeSession("s1", "d1")
    env.authority.sessions["s2"] = FakeSession("s2", "d1")

    def fail_write(path, payload):
        raise OSError("disk full")
    monkeypatch.setattr(dashboard_routes, "atomic_write_json", fail_write)

    with pytest.raises(OSError, match="disk full"):
        request(env.app, "POST", "/api/dashboards/d1/duplicate")
    assert sorted(env.authority.deleted) == ["dup-s1", "dup-s2"]
    assert env.telemetry.events == []
    assert sorted(item.name for item in env.data_dir.iterdir()) == ["d1.json"]


def test_duplicate_rollback_falls_back_to_purging_a_session_that_will_not_delete(env, monkeypatch):
    dashboard_routes.save(Dashboard(id="d1", name="Source", layout={"cards": {"s1": {"session_id": "s1"}}}))
    env.authority.sessions["s1"] = FakeSession("s1", "d1")

    async def refuse_delete(session_id):
        raise RuntimeError("delete refused")
    env.authority.delete_session = refuse_delete
    monkeypatch.setattr(dashboard_routes, "atomic_write_json", lambda path, payload: (_ for _ in ()).throw(OSError("disk full")))

    with pytest.raises(OSError, match="disk full"):
        request(env.app, "POST", "/api/dashboards/d1/duplicate")
    assert env.authority.purged == ["dup-s1"]


def test_generate_name_uses_injected_authority_and_naming(env):
    dashboard_routes.save(Dashboard(id="d1", name="Untitled Dashboard"))
    session = FakeSession("s1", "d1")
    session.messages = [SimpleNamespace(role="user", content="Review the launch checklist today")]
    env.authority.sessions["s1"] = session

    response = request(env.app, "POST", "/api/dashboards/d1/generate-name")
    assert response.status_code == 200
    assert response.json() == {"name": "Review the launch checklist", "auto_named": True}


def test_get_pruning_accepts_injected_authority_argument(env):
    authority = FakeAuthority(sessions={"live1": FakeSession("live1", "d1")}, disk={"disk1": {}})
    data = {"layout": {
        "cards": {
            "live1": {"session_id": "live1"},
            "disk1": {"session_id": "disk1"},
            "gone1": {"session_id": "gone1"},
            "draft-x": {"session_id": "draft-x"},
        },
        "expanded_session_ids": ["live1", "gone1"],
    }}
    dashboard_routes.strip_orphan_session_cards(data, authority)
    assert set(data["layout"]["cards"]) == {"live1", "disk1", "draft-x"}
    assert data["layout"]["expanded_session_ids"] == ["live1"]


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
                    name.startswith("backend.apps.") and not name.startswith("backend.apps.dashboards")
                    for name in names
                ):
                    offenders.append(child.lineno)
            walk(child, inner)

    walk(tree, False)
    return offenders


def test_dashboards_has_no_function_local_sibling_imports():
    repo = Path(__file__).resolve().parents[2]
    for rel in ("backend/apps/dashboards/dashboards.py", "backend/apps/dashboards/dashboard_runtime.py"):
        assert function_local_sibling_imports(repo / rel) == [], f"{rel} regressed to lazy sibling imports"
