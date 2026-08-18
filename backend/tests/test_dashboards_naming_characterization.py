"""Characterization tests for dashboard card pruning and auto-naming.

Pins the observable behavior of GET /{id} orphan-card pruning and
POST /{id}/generate-name in backend/apps/dashboards/dashboards.py across the
move of their sibling-app calls behind the injected dashboard_runtime
boundary: draft cards always survive, the stored file is never modified by
pruning, naming falls back to the first four prompt words on aux failure, and
a successful aux stream is cleaned and persisted. Seams patched here (module
attributes on agent_manager, session_store, settings, credentials, registry,
aux_llm) keep working identically through the default adapters.

Run:
    python -m pytest backend/tests/test_dashboards_naming_characterization.py -v
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import backend.apps.agents.agent_manager as agent_manager_module
import backend.apps.agents.core.aux_llm as aux_llm_module
import backend.apps.agents.manager.session.session_store as session_store_module
import backend.apps.agents.providers.registry as registry_module
import backend.apps.settings.credentials as credentials_module
import backend.apps.settings.settings as settings_module
from backend.apps.dashboards import dashboards as dashboard_routes
from backend.apps.dashboards.models import Dashboard


class FakeMessage:
    def __init__(self, role, content):
        self.role = role
        self.content = content


class FakeSession:
    def __init__(self, id, dashboard_id, messages=()):
        self.id = id
        self.dashboard_id = dashboard_id
        self.messages = list(messages)


class FakeAgentManager:
    def __init__(self):
        self.sessions = {}


class FakeStream:
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    @property
    def text_stream(self):
        async def gen():
            for chunk in self.chunks:
                yield chunk
        return gen()


@pytest.fixture
def env(tmp_path, monkeypatch):
    data_dir = tmp_path / "dashboards"
    data_dir.mkdir()
    monkeypatch.setattr(dashboard_routes, "DATA_DIR", str(data_dir))
    manager = FakeAgentManager()
    monkeypatch.setattr(agent_manager_module, "agent_manager", manager)
    app = FastAPI()
    app.include_router(dashboard_routes.dashboards.router, prefix="/api/dashboards")
    return SimpleNamespace(
        app=app, data_dir=data_dir, manager=manager, monkeypatch=monkeypatch,
    )


def request(app, method, path, json_payload=None):
    async def go():
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.request(method, path, json=json_payload)
    return asyncio.run(go())


def card(session_id):
    return {"session_id": session_id, "x": 1, "y": 2}


# --- GET orphan-card pruning --------------------------------------------------

def test_get_prunes_only_vanished_cards_and_never_touches_disk(env):
    dashboard_routes.save(Dashboard(
        id="d1", name="Board",
        layout={
            "cards": {
                "live1": card("live1"),
                "disk1": card("disk1"),
                "gone1": card("gone1"),
                "draft-x": card("draft-x"),
            },
            "expanded_session_ids": ["live1", "gone1"],
        },
    ))
    env.manager.sessions["live1"] = FakeSession("live1", "d1")
    probed = []

    def fake_load_session_data(sid):
        probed.append(sid)
        return {} if sid == "disk1" else None
    env.monkeypatch.setattr(session_store_module, "load_session_data", fake_load_session_data)
    stored_before = (env.data_dir / "d1.json").read_bytes()

    response = request(env.app, "GET", "/api/dashboards/d1")
    assert response.status_code == 200
    layout = response.json()["layout"]
    assert set(layout["cards"]) == {"live1", "disk1", "draft-x"}
    assert layout["expanded_session_ids"] == ["live1"]
    assert sorted(probed) == ["disk1", "gone1"]
    assert (env.data_dir / "d1.json").read_bytes() == stored_before


# --- generate-name ------------------------------------------------------------

def seed_named_dashboard(auto_named, name):
    dashboard_routes.save(Dashboard(id="d1", name=name, auto_named=auto_named))


def generate_name(env):
    return request(env.app, "POST", "/api/dashboards/d1/generate-name")


def test_custom_named_dashboard_is_returned_untouched(env):
    seed_named_dashboard(auto_named=False, name="My Board")
    response = generate_name(env)
    assert response.status_code == 200
    assert response.json() == {"name": "My Board", "auto_named": False}


def test_no_matching_prompts_keeps_current_name(env):
    seed_named_dashboard(auto_named=True, name="Old Auto Name")
    env.manager.sessions["s9"] = FakeSession(
        "s9", "other-dashboard", [FakeMessage("user", "Unrelated prompt")],
    )
    response = generate_name(env)
    assert response.status_code == 200
    assert response.json() == {"name": "Old Auto Name", "auto_named": True}


def test_aux_failure_falls_back_to_first_four_prompt_words(env):
    seed_named_dashboard(auto_named=False, name="Untitled Dashboard")
    env.manager.sessions["s1"] = FakeSession(
        "s1", "d1", [FakeMessage("user", "Plan a big trip to Tokyo next week")],
    )

    def explode():
        raise RuntimeError("no settings")
    env.monkeypatch.setattr(settings_module, "load_settings", explode)

    response = generate_name(env)
    assert response.status_code == 200
    assert response.json() == {"name": "Plan a big trip", "auto_named": True}
    reloaded = request(env.app, "GET", "/api/dashboards/d1").json()
    assert reloaded["name"] == "Plan a big trip"
    assert reloaded["auto_named"] is True


def test_streamed_label_is_cleaned_and_persisted(env):
    seed_named_dashboard(auto_named=True, name="Old Auto Name")
    env.manager.sessions["s1"] = FakeSession(
        "s1", "d1", [FakeMessage("user", "Compare hotel options for the offsite")],
    )
    stream_kwargs = {}

    class FakeMessages:
        def stream(self, **kwargs):
            stream_kwargs.update(kwargs)
            return FakeStream(["Offsite ", "Logistics"])

    class FakeClient:
        messages = FakeMessages()

    async def fake_resolve_aux_model(settings, *, preferred_tier):
        assert preferred_tier == "haiku"
        return "haiku-model", None

    env.monkeypatch.setattr(settings_module, "load_settings", lambda: SimpleNamespace())
    env.monkeypatch.setattr(registry_module, "resolve_aux_model", fake_resolve_aux_model)
    env.monkeypatch.setattr(
        credentials_module, "get_anthropic_client_for_model",
        lambda settings, model: FakeClient(),
    )
    env.monkeypatch.setattr(aux_llm_module, "clean_short_label", lambda text: f"Cleaned {text.strip()}")
    env.monkeypatch.setattr(aux_llm_module, "aux_max_tokens_for", lambda model: 16)

    response = generate_name(env)
    assert response.status_code == 200
    assert response.json() == {"name": "Cleaned Offsite Logistics", "auto_named": True}
    assert stream_kwargs["model"] == "haiku-model"
    assert stream_kwargs["max_tokens"] == 16
    reloaded = request(env.app, "GET", "/api/dashboards/d1").json()
    assert reloaded["name"] == "Cleaned Offsite Logistics"


def test_empty_cleaned_label_keeps_first_words_fallback(env):
    seed_named_dashboard(auto_named=True, name="Old Auto Name")
    env.manager.sessions["s1"] = FakeSession(
        "s1", "d1", [FakeMessage("user", "Draft the quarterly budget review deck")],
    )

    class FakeMessages:
        def stream(self, **kwargs):
            return FakeStream(["   "])

    class FakeClient:
        messages = FakeMessages()

    async def fake_resolve_aux_model(settings, *, preferred_tier):
        return "haiku-model", None

    env.monkeypatch.setattr(settings_module, "load_settings", lambda: SimpleNamespace())
    env.monkeypatch.setattr(registry_module, "resolve_aux_model", fake_resolve_aux_model)
    env.monkeypatch.setattr(
        credentials_module, "get_anthropic_client_for_model",
        lambda settings, model: FakeClient(),
    )
    env.monkeypatch.setattr(aux_llm_module, "clean_short_label", lambda text: text.strip())
    env.monkeypatch.setattr(aux_llm_module, "aux_max_tokens_for", lambda model: 16)

    response = generate_name(env)
    assert response.status_code == 200
    assert response.json() == {"name": "Draft the quarterly budget", "auto_named": True}
