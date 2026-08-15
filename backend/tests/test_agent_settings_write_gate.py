"""The SettingsWrite gate is enforced by dispatch, not just drawn in Settings (ENG-284).

SettingsWrite was the one agent tool with no user-facing gate, and it is the tool that can undo the
others. The rule this file exists to enforce is the one from CLAUDE.md: a permission toggle no
dispatch code reads is worse than no toggle, because it sells a boundary that is not there. So the
interesting test is not "the switch stores a bool", it is "a client that ignores the tool list and
posts straight to the route is still refused".
"""
import pytest
from fastapi.testclient import TestClient

from backend.apps.settings.agent_settings_write_allowed import REFUSAL_REASON, agent_settings_write_allowed
from backend.apps.settings.models import AppSettings


def test_defaults_on_so_nobody_loses_a_capability():
    assert agent_settings_write_allowed(AppSettings()) is True
    assert AppSettings().agent_settings_write_enabled is True


def test_only_an_explicit_false_turns_it_off():
    assert agent_settings_write_allowed(AppSettings(agent_settings_write_enabled=False)) is False
    assert agent_settings_write_allowed(AppSettings(agent_settings_write_enabled=True)) is True


def test_a_settings_object_from_an_older_install_still_reads_as_allowed():
    class Old:
        pass

    assert agent_settings_write_allowed(Old()) is True


@pytest.fixture()
def p_client():
    import secrets

    import backend.auth as auth_mod
    from backend.main import app

    if not auth_mod.TOKEN:
        auth_mod.TOKEN = secrets.token_urlsafe(32)
    return TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"})


@pytest.fixture(autouse=True)
def p_restore_settings():
    from backend.apps.settings.settings import load_settings, save_settings

    original = load_settings().model_copy(deep=True)
    yield
    save_settings(original)


def p_write(client, changes):
    return client.post("/api/settings-meta/write", json={"changes": changes, "parent_session_id": ""})


def p_set_gate(monkeypatch, allowed: bool):
    import backend.main as main_module

    monkeypatch.setattr(
        "backend.apps.settings.agent_settings_write_allowed.agent_settings_write_allowed",
        lambda s: allowed,
    )
    assert main_module is not None


def test_the_route_refuses_every_field_when_the_gate_is_off(p_client, monkeypatch):
    # The forced bypass: a client that never saw the tool list, posting directly. This is the only
    # wall that matters, because the tool list is advice and the route is enforcement.
    p_set_gate(monkeypatch, False)
    res = p_write(p_client, {"theme": "light", "memory_enabled": False})
    assert res.status_code == 200
    outcomes = res.json()["outcomes"]
    assert set(outcomes) == {"theme", "memory_enabled"}
    for field, outcome in outcomes.items():
        assert outcome["status"] == "refused", f"{field} was not refused"
        assert outcome["reason"] == REFUSAL_REASON


def test_nothing_is_written_to_disk_when_the_gate_is_off(p_client, monkeypatch):
    from backend.apps.settings.store import load_settings

    before = load_settings().theme
    p_set_gate(monkeypatch, False)
    p_write(p_client, {"theme": "light" if before != "light" else "dark"})
    assert load_settings().theme == before, "a refused write must not reach the settings file"


def test_the_gate_open_still_applies_a_write(p_client, monkeypatch):
    # Both directions: a gate that refuses everything would pass the test above and be useless.
    from backend.apps.settings.store import load_settings

    p_set_gate(monkeypatch, True)
    res = p_write(p_client, {"memory_enabled": False})
    assert res.status_code == 200
    assert res.json()["outcomes"]["memory_enabled"]["status"] == "applied"
    assert load_settings().memory_enabled is False


def test_read_is_never_gated(p_client, monkeypatch):
    # Reading is how an agent answers "what is your theme"; the gate is about changing things.
    p_set_gate(monkeypatch, False)
    res = p_client.post("/api/settings-meta/read", json={"parent_session_id": ""})
    assert res.status_code == 200
    assert "settings" in res.json()


def p_tool_lists(monkeypatch, write_enabled: bool):
    """The real builder, driven with a core server carrying the always-on modules."""
    import backend.apps.settings.store as store
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents.manager.permissions.build_effective_tool_lists import build_effective_tool_lists

    # The builder imports load_settings from the store at call time, so patching the module is what
    # a real Settings change looks like from its point of view.
    monkeypatch.setattr(store, "load_settings", lambda: AppSettings(agent_settings_write_enabled=write_enabled))
    session = AgentSession(id="tool-list-test", name="t", model="opus-4-8")
    servers = {"openswarm-core": {"env": {"OSW_MCP_MODULES": "meta,settings,apps"}}}
    return build_effective_tool_lists(session, servers, {}, False, [], [])


def test_the_tool_list_stops_offering_the_write_when_it_is_off(monkeypatch):
    allowed, disallowed = p_tool_lists(monkeypatch, write_enabled=False)
    assert "mcp__openswarm-core__SettingsWrite" not in allowed
    assert "mcp__openswarm-core__SettingsWrite" in disallowed
    # SettingsRead survives: reading redacted settings is how an agent answers without changing anything.
    assert "mcp__openswarm-core__SettingsRead" in allowed


def test_the_tool_list_offers_the_write_when_it_is_on(monkeypatch):
    allowed, disallowed = p_tool_lists(monkeypatch, write_enabled=True)
    assert "mcp__openswarm-core__SettingsWrite" in allowed
    assert "mcp__openswarm-core__SettingsWrite" not in disallowed
