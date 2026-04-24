import pytest

from backend.apps.agents.agent_manager import AgentManager
from backend.apps.agents.models import AgentConfig
from backend.apps.agents.providers.registry import resolve_available_chat_model
from backend.apps.settings.models import AppSettings


@pytest.mark.asyncio
async def test_resolver_prefers_codex_mini_when_claude_default_is_unavailable(monkeypatch):
    import backend.apps.nine_router as nine_router_mod

    monkeypatch.setattr(nine_router_mod, "is_running", lambda: True)

    async def fake_get_providers():
        return {"connections": [{"provider": "codex", "isActive": True}]}

    monkeypatch.setattr(nine_router_mod, "get_providers", fake_get_providers)

    model, provider = await resolve_available_chat_model(
        AppSettings(default_model="sonnet", anthropic_api_key=None),
        "sonnet",
    )

    assert model == "gpt-5.4-mini"
    assert provider == "openai"


@pytest.mark.asyncio
async def test_launch_replaces_unavailable_claude_default_with_codex(monkeypatch):
    import backend.apps.agents.agent_manager as agent_manager_mod

    monkeypatch.setattr(
        agent_manager_mod,
        "load_settings",
        lambda: AppSettings(default_model="sonnet", anthropic_api_key=None),
    )

    async def fake_connected_models(_settings, requested_model):
        return ("gpt-5.4-mini", "openai")

    monkeypatch.setattr(
        agent_manager_mod,
        "resolve_available_chat_model",
        fake_connected_models,
    )

    session = await AgentManager().launch_agent(
        AgentConfig(name="New chat", model="sonnet", mode="agent", provider="anthropic")
    )

    assert session.model == "gpt-5.4-mini"
    assert session.provider == "openai"


@pytest.mark.asyncio
async def test_subscription_sync_persists_resolved_default_model(monkeypatch):
    import backend.apps.agents.agents as agents_mod
    import backend.apps.agents.providers.registry as registry_mod
    import backend.apps.settings.settings as settings_mod

    settings = AppSettings(default_model="sonnet", anthropic_api_key=None)
    saved = []

    monkeypatch.setattr(settings_mod, "load_settings", lambda: settings)
    monkeypatch.setattr(settings_mod, "_save_settings", lambda updated: saved.append(updated.default_model))

    async def fake_resolver(_settings, requested_model):
        assert requested_model == "sonnet"
        return ("gpt-5.4-mini", "openai")

    monkeypatch.setattr(registry_mod, "resolve_available_chat_model", fake_resolver)

    await agents_mod._sync_default_model_to_available_provider()

    assert settings.default_model == "gpt-5.4-mini"
    assert saved == ["gpt-5.4-mini"]
