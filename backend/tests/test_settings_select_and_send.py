"""Proof that selecting a Settings row and sending threads selected_setting_ids
from the HTTP boundary into the run, and produces the focused context block.

Covers the backend half definitively (HTTP -> send_message kwarg; the context
builder output). The browser half (click a row -> the POST body carries
selected_setting_ids) is proven live via CDP.
"""

from __future__ import annotations

import secrets

import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture
def client():
    import backend.auth as auth_mod
    if not auth_mod.TOKEN:
        auth_mod.TOKEN = secrets.token_urlsafe(32)
    return TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"})


def test_message_endpoint_threads_selected_setting_ids(client, monkeypatch):
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.core.models import AgentSession
    captured: dict = {}
    agent_manager.sessions["sess-x"] = AgentSession(id="sess-x", name="test")

    async def fake_send(session_id, prompt, **kwargs):
        captured["session_id"] = session_id
        captured["kwargs"] = kwargs

    try:
        monkeypatch.setattr(agent_manager, "send_message", fake_send)
        r = client.post(
            "/api/agents/sessions/sess-x/message",
            json={"prompt": "flip my theme to light", "selected_setting_ids": ["theme", "default_model"]},
        )
        assert r.status_code == 200, r.text
        assert captured["kwargs"].get("selected_setting_ids") == ["theme", "default_model"]
    finally:
        agent_manager.sessions.pop("sess-x", None)


def test_selected_settings_context_block_targets_the_fields():
    from backend.apps.agents.manager.prompt.prompt_context import build_selected_settings_context
    assert build_selected_settings_context(None) is None
    assert build_selected_settings_context([]) is None
    block = build_selected_settings_context(["theme", "default_model"])
    assert "theme" in block and "default_model" in block
    # It tells the agent to use the always-on settings tools on exactly these fields.
    assert "SettingsRead" in block and "SettingsWrite" in block
    # Targeting aid, not a gate: it focuses, never claims to unlock anything.
    assert "Leave unrelated settings alone" in block
