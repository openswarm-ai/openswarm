"""Characterization tests for dashboards lifecycle cross-app behavior.

Pins the observable behavior of the create/delete/duplicate routes in
backend/apps/dashboards/dashboards.py across the move of their sibling-app
calls behind the injected dashboard_runtime boundary: telemetry emission and
failure swallowing, owned-session removal on delete, and session copy/remap on
duplicate. Exercised via a lifespan-free FastAPI harness; the seams patched here
(module attributes on agent_manager, session_store, analytics client) keep
working identically through the default adapters.

Run:
    python -m pytest backend/tests/test_dashboards_lifecycle_characterization.py -v
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import backend.apps.agents.agent_manager as agent_manager_module
import backend.apps.agents.manager.session.session_store as session_store_module
import backend.apps.service.analytics.client as analytics_module
from backend.apps.dashboards import dashboards as dashboard_routes
from backend.apps.dashboards.models import Dashboard


class FakeSession:
    def __init__(self, id, dashboard_id, browser_id=None, parent_session_id=None):
        self.id = id
        self.dashboard_id = dashboard_id
        self.browser_id = browser_id
        self.parent_session_id = parent_session_id
        self.messages = []

    def model_dump(self, mode="json"):
        return {
            "id": self.id,
            "dashboard_id": self.dashboard_id,
            "browser_id": self.browser_id,
            "parent_session_id": self.parent_session_id,
        }


class FakeAgentManager:
    def __init__(self):
        self.sessions = {}
        self.deleted = []
        self.duplicated = []
        self.purged = []

    async def delete_session(self, sid):
        self.deleted.append(sid)
        self.sessions.pop(sid, None)

    async def duplicate_session(self, sid, *, dashboard_id):
        self.duplicated.append(sid)
        return FakeSession(f"dup-{sid}", dashboard_id)

    def purge_session_memory(self, sid):
        self.purged.append(sid)


@pytest.fixture
def env(tmp_path, monkeypatch):
    data_dir = tmp_path / "dashboards"
    sessions_dir = tmp_path / "sessions"
    data_dir.mkdir()
    sessions_dir.mkdir()
    monkeypatch.setattr(dashboard_routes, "DATA_DIR", str(data_dir))
    monkeypatch.setattr(dashboard_routes, "SESSIONS_DIR", str(sessions_dir))
    manager = FakeAgentManager()
    monkeypatch.setattr(agent_manager_module, "agent_manager", manager)
    events = []
    monkeypatch.setattr(
        analytics_module, "track_dashboard_event",
        lambda *, dashboard_id, action: events.append((action, dashboard_id)),
    )
    saved_sessions = []
    monkeypatch.setattr(
        session_store_module, "save_session",
        lambda sid, data: saved_sessions.append((sid, data)),
    )
    app = FastAPI()
    app.include_router(dashboard_routes.dashboards.router, prefix="/api/dashboards")
    return SimpleNamespace(
        app=app, data_dir=data_dir, sessions_dir=sessions_dir,
        manager=manager, events=events, saved_sessions=saved_sessions,
        monkeypatch=monkeypatch,
    )


def request(app, method, path, json_payload=None):
    async def go():
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, json=json_payload)
    return asyncio.run(go())


def write_session_file(sessions_dir, sid, dashboard_id):
    (sessions_dir / f"{sid}.json").write_text(json.dumps({"id": sid, "dashboard_id": dashboard_id}))


# --- create -------------------------------------------------------------------

def test_create_emits_create_telemetry_and_persists(env):
    response = request(env.app, "POST", "/api/dashboards/create", {"name": "Fresh"})
    assert response.status_code == 200
    created_id = response.json()["id"]
    assert env.events == [("create", created_id)]
    assert (env.data_dir / f"{created_id}.json").exists()


def test_create_survives_telemetry_failure(env):
    def explode(*, dashboard_id, action):
        raise RuntimeError("telemetry down")
    env.monkeypatch.setattr(analytics_module, "track_dashboard_event", explode)
    response = request(env.app, "POST", "/api/dashboards/create", {"name": "Fresh"})
    assert response.status_code == 200
    assert (env.data_dir / f"{response.json()['id']}.json").exists()


# --- delete -------------------------------------------------------------------

def test_delete_removes_owned_disk_and_live_sessions_only(env):
    dashboard_routes.save(Dashboard(id="d1", name="Doomed"))
    write_session_file(env.sessions_dir, "mine", "d1")
    write_session_file(env.sessions_dir, "other", "d2")
    env.manager.sessions["live1"] = FakeSession("live1", "d1")
    env.manager.sessions["live2"] = FakeSession("live2", "d2")

    response = request(env.app, "DELETE", "/api/dashboards/d1")
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert not (env.sessions_dir / "mine.json").exists()
    assert (env.sessions_dir / "other.json").exists()
    assert env.manager.deleted == ["live1"]
    assert not (env.data_dir / "d1.json").exists()
    assert env.events == [("delete", "d1")]


def test_delete_missing_dashboard_is_404_and_silent(env):
    response = request(env.app, "DELETE", "/api/dashboards/ghost")
    assert response.status_code == 404
    assert env.events == []


def test_delete_survives_telemetry_failure(env):
    dashboard_routes.save(Dashboard(id="d1", name="Doomed"))

    def explode(*, dashboard_id, action):
        raise RuntimeError("telemetry down")
    env.monkeypatch.setattr(analytics_module, "track_dashboard_event", explode)
    response = request(env.app, "DELETE", "/api/dashboards/d1")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


# --- duplicate ----------------------------------------------------------------

def test_duplicate_copies_sessions_and_remaps_layout(env):
    dashboard_routes.save(Dashboard(
        id="d1", name="Source",
        layout={
            "cards": {"s1": {"session_id": "s1", "x": 10, "y": 20}},
            "browser_cards": {"b1": {"browser_id": "b1", "spawned_by": "s1"}},
            "expanded_session_ids": ["s1", "vanished"],
        },
    ))
    env.manager.sessions["s1"] = FakeSession("s1", "d1", browser_id="b1")
    write_session_file(env.sessions_dir, "s2", "d1")
    write_session_file(env.sessions_dir, "elsewhere", "d9")

    response = request(env.app, "POST", "/api/dashboards/d1/duplicate")
    assert response.status_code == 200
    body = response.json()

    assert body["name"] == "Source (copy)"
    assert body["id"] != "d1"
    assert sorted(env.manager.duplicated) == ["s1", "s2"]
    assert sorted(sid for sid, _ in env.saved_sessions) == ["dup-s1", "dup-s2"]

    assert set(body["layout"]["cards"]) == {"dup-s1"}
    assert body["layout"]["cards"]["dup-s1"]["session_id"] == "dup-s1"
    assert body["layout"]["cards"]["dup-s1"]["x"] == 10

    new_browser_cards = body["layout"]["browser_cards"]
    assert len(new_browser_cards) == 1
    new_bid, new_browser_card = next(iter(new_browser_cards.items()))
    assert new_bid != "b1"
    assert new_browser_card["browser_id"] == new_bid
    assert new_browser_card["spawned_by"] == "dup-s1"

    assert body["layout"]["expanded_session_ids"] == ["dup-s1"]
    assert (env.data_dir / f"{body['id']}.json").exists()
    assert env.events == [("create", body["id"])]


def test_duplicate_missing_dashboard_is_404(env):
    response = request(env.app, "POST", "/api/dashboards/ghost/duplicate")
    assert response.status_code == 404
    assert env.manager.duplicated == []
    assert env.events == []
