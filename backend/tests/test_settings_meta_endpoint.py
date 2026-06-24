"""End-to-end coverage of /api/settings-meta (the agent-editable Settings tool).

Drives the real FastAPI route with a real in-memory AgentSession so the guard
runs against an actual run's model, exactly as it will in production. The unit
invariant lives in test_settings_meta_guard.py; this test proves the wiring:
redaction on read, the three write refusals, and a benign write actually landing.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.mark.asyncio
async def test_second_wall_restores_protected_credential_even_if_body_blanks_it():
    """Defense in depth: even if a write reaches apply_settings_update with the
    live credential blanked (a guard slip upstream), the second-wall restore puts
    it back. Proves the api-key guard isn't a single point of failure."""
    from backend.apps.settings.settings import (
        apply_settings_update, settings_write_lock, load_settings, save_settings,
    )
    original = load_settings().model_copy(deep=True)
    try:
        s = load_settings()
        s.anthropic_api_key = "sk-live-KEEP-ME"
        save_settings(s)
        # A body that (as if a guard bug let it through) clears the live key.
        body = load_settings()
        body.anthropic_api_key = ""
        async with settings_write_lock():
            saved = await apply_settings_update(body, protect_fields={"anthropic_api_key"})
        assert saved.anthropic_api_key == "sk-live-KEEP-ME", "second wall failed to restore"
        assert load_settings().anthropic_api_key == "sk-live-KEEP-ME"
        # And a NON-protected blank still goes through (only the protected one is restored).
        body2 = load_settings()
        body2.openai_api_key = ""
        async with settings_write_lock():
            await apply_settings_update(body2, protect_fields={"anthropic_api_key"})
        assert not load_settings().openai_api_key
    finally:
        save_settings(original)


@pytest.fixture
def client():
    import backend.auth as auth_mod
    if not auth_mod._TOKEN:
        import secrets
        auth_mod._TOKEN = secrets.token_urlsafe(32)
    return TestClient(app, headers={"Authorization": f"Bearer {auth_mod._TOKEN}"})


@pytest.fixture
def reset_settings():
    from backend.apps.settings.settings import load_settings, save_settings
    original = load_settings().model_copy(deep=True)
    yield
    save_settings(original)


@pytest.fixture
def session_on_anthropic_key():
    """A live run on opus-4-8 in own_key mode with an Anthropic key set: the
    Anthropic key powers it. Registered in agent_manager so the guard sees it."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.settings.settings import load_settings, save_settings

    s = load_settings()
    s.connection_mode = "own_key"
    s.anthropic_api_key = "sk-ant-test-LIVE"
    s.openai_api_key = "sk-openai-test-OTHER"
    save_settings(s)

    sess = AgentSession(id="settings-meta-test", name="t", model="opus-4-8")
    agent_manager.sessions["settings-meta-test"] = sess
    yield "settings-meta-test"
    agent_manager.sessions.pop("settings-meta-test", None)


def test_read_redacts_every_secret(client, reset_settings):
    r = client.post("/api/settings-meta/read", json={})
    assert r.status_code == 200, r.text
    settings = r.json()["settings"]
    # Secret fields come back as state, never a raw string value.
    for field in ("anthropic_api_key", "openai_api_key", "claude_subscription_token", "openswarm_bearer_token"):
        if field in settings:
            assert isinstance(settings[field], dict), f"{field} leaked as a raw value"
            assert "configured" in settings[field]
    # A non-secret field is passed through untouched.
    assert settings["theme"] in ("dark", "light")


def test_benign_write_applies(client, reset_settings):
    r = client.post("/api/settings-meta/write", json={"changes": {"theme": "light"}})
    assert r.status_code == 200, r.text
    assert r.json()["outcomes"]["theme"]["status"] == "applied"
    from backend.apps.settings.settings import load_settings
    assert load_settings().theme == "light"


def test_unknown_and_server_owned_fields_are_refused(client, reset_settings):
    r = client.post("/api/settings-meta/write", json={"changes": {
        "not_a_real_field": 1,
        "connection_mode": "openswarm-pro",
        "openswarm_bearer_token": "forged",
    }})
    assert r.status_code == 200, r.text
    out = r.json()["outcomes"]
    assert out["not_a_real_field"]["status"] == "unknown"
    assert out["connection_mode"]["status"] == "refused"
    assert out["openswarm_bearer_token"]["status"] == "refused"
    # And the server-owned field is genuinely untouched on disk.
    from backend.apps.settings.settings import load_settings
    assert load_settings().connection_mode != "openswarm-pro"


def test_cannot_suicide_but_disconnects_others(client, reset_settings, session_on_anthropic_key):
    """The spec scenario over HTTP: run on the Anthropic key, asked to clear
    every model key + flip a benign setting. It must refuse the live key,
    clear the other one, and apply the benign change, all in one call."""
    sid = session_on_anthropic_key
    r = client.post("/api/settings-meta/write", json={
        "parent_session_id": sid,
        "changes": {
            "anthropic_api_key": "",
            "openai_api_key": "",
            "theme": "light",
        },
    })
    assert r.status_code == 200, r.text
    out = r.json()["outcomes"]
    assert out["anthropic_api_key"]["status"] == "refused", "blanked the live credential!"
    assert "powering this run" in out["anthropic_api_key"]["reason"]
    assert out["openai_api_key"]["status"] == "applied"
    assert out["theme"]["status"] == "applied"

    from backend.apps.settings.settings import load_settings
    s = load_settings()
    assert s.anthropic_api_key == "sk-ant-test-LIVE", "live key was cleared despite refusal"
    assert not s.openai_api_key, "the other provider's key should have been cleared"
    assert s.theme == "light"
