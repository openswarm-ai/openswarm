"""The sub-agent model pin on the 9Router-direct route must come from LIVE router
connections. The run/ split passed a hardcoded empty list, the pin never fired, and every
sub-agent 401'd ("No credentials for provider: anthropic") while the parent turn worked."""
import asyncio
from typing import Dict

from pytest import MonkeyPatch

import backend.apps.agents.manager.configure_provider_env as cpe
from backend.apps.agents.core.models import AgentSession
from backend.apps.settings.models import AppSettings


def run_env_for(connections: list, monkeypatch: MonkeyPatch) -> Dict:
    import backend.apps.nine_router as nr_pkg

    async def fake_get_providers() -> list:
        return connections

    monkeypatch.setattr(nr_pkg, "is_running", lambda: True)
    monkeypatch.setattr(nr_pkg, "get_providers", fake_get_providers)
    session = AgentSession(name="t", model="opus-4-8-cc")
    options_kwargs: Dict = {}
    asyncio.run(
        cpe.configure_provider_env(
            options_kwargs, session, "cc/claude-opus-4-8", "anthropic", AppSettings()
        )
    )
    return options_kwargs.get("env", {})


def test_subagent_pin_set_from_live_claude_connection(monkeypatch: MonkeyPatch) -> None:
    env = run_env_for([{"provider": "claude", "isActive": True}], monkeypatch)
    assert env.get("CLAUDE_CODE_SUBAGENT_MODEL") == "cc/claude-sonnet-4-6"
    assert env.get("ANTHROPIC_SMALL_FAST_MODEL") == "cc/claude-haiku-4-5-20251001"


def test_subagent_pin_absent_only_when_no_active_lane(monkeypatch: MonkeyPatch) -> None:
    env = run_env_for([], monkeypatch)
    assert "CLAUDE_CODE_SUBAGENT_MODEL" not in env


def test_subagent_pin_codex_lane(monkeypatch: MonkeyPatch) -> None:
    env = run_env_for([{"provider": "codex", "isActive": True}], monkeypatch)
    assert env.get("CLAUDE_CODE_SUBAGENT_MODEL") == "cx/gpt-5.4-mini"
