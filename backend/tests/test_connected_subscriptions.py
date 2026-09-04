"""Chuya, 2026-09-04: she connected Claude Pro/Max (the Settings page said Connected, the chat ran on
Sonnet through it) and the agent told her "No, not connected: claude_subscription_token shows as not
configured". That field is dead; the router holds the subscription. Every "connected?" answer now
reads the router, and a router that cannot answer reads as unknown, never as disconnected."""

import asyncio

import pytest
from fastapi.testclient import TestClient

import backend.apps.nine_router as nr
from backend.apps.nine_router import connected
from backend.apps.settings.models import LEGACY_SUBSCRIPTION_TOKEN_FIELDS


def p_conns(*rows):
    async def fake():
        return list(rows)
    return fake


def test_the_router_answer_excludes_our_managed_node_dead_nodes_and_duplicates(monkeypatch):
    monkeypatch.setattr(nr, "is_running", lambda: True)
    monkeypatch.setattr(nr, "get_providers", p_conns(
        {"provider": "claude", "name": "Chuya's Claude", "isActive": True},
        {"provider": "claude", "name": "Chuya's other Claude", "isActive": True},
        {"provider": "claude", "name": nr.NINE_ROUTER_CLAUDE_PRO_NAME, "isActive": True},
        {"provider": "codex", "name": "old", "isActive": False},
        {"provider": "openrouter", "name": "key", "isActive": True},
    ))
    assert asyncio.run(connected.connected_subscription_providers()) == ["claude"]
    assert connected.subscription_labels(["claude", "gemini-cli"]) == ["Claude Pro/Max", "Gemini Advanced"]


def test_a_router_that_is_down_answers_unknown_not_disconnected(monkeypatch):
    monkeypatch.setattr(nr, "is_running", lambda: False)
    assert asyncio.run(connected.connected_subscription_providers()) is None
    assert connected.subscription_labels(None) == connected.ROUTER_UNKNOWN


def test_the_settings_read_tool_hides_the_dead_fields_and_names_the_router_subscription(monkeypatch):
    from backend.main import app

    async def claude_only():
        return ["claude"]
    monkeypatch.setattr(connected, "connected_subscription_providers", claude_only)
    import secrets

    import backend.auth as auth_mod
    if not auth_mod.TOKEN:
        auth_mod.TOKEN = secrets.token_urlsafe(32)
    with TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"}) as client:
        r = client.post("/api/settings-meta/read", json={})
    assert r.status_code == 200, r.text
    view = r.json()["settings"]
    for field in LEGACY_SUBSCRIPTION_TOKEN_FIELDS:
        assert field not in view, f"{field} still reaches the agent as 'not configured'"
    assert view["connected_subscriptions"] == ["Claude Pro/Max"]


def test_the_read_tool_renders_the_subscription_line_in_words():
    from backend.apps.agents.settings_meta_server import p_format_read

    text = p_format_read({"connected_subscriptions": ["Claude Pro/Max"], "anthropic_api_key": {"configured": False}})
    assert "- connected_subscriptions: Claude Pro/Max (subscriptions live in the app's router" in text
    assert "- anthropic_api_key: not configured" in text
    assert "connected_subscriptions: none" in p_format_read({"connected_subscriptions": []})
    assert connected.ROUTER_UNKNOWN in p_format_read({"connected_subscriptions": connected.ROUTER_UNKNOWN})


@pytest.mark.parametrize("subs, keyed, expected", [
    (["claude"], False, "on a connected provider subscription"),
    ([], True, "on their own API key"),
    ([], False, "with NO model connected yet"),
    (None, False, "unknown model state"),
])
def test_the_help_agent_is_told_the_router_answer(monkeypatch, subs, keyed, expected):
    from backend.apps.help import knowledge
    from backend.apps.settings import store

    class S:
        connection_mode = "own_key"
        anthropic_api_key = "sk-ant-x" if keyed else None
        openai_api_key = None
        google_api_key = None
        openrouter_api_key = None
        claude_subscription_token = None
    monkeypatch.setattr(store, "load_settings", lambda: S())
    assert expected in knowledge.p_provider_state(subs)
