"""Characterization coverage for provider-runtime boundary extraction."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import patch

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager import configure_provider_env as provider_env
from backend.apps.settings.models import AppSettings


def test_router_available_rechecks_after_evidence_based_revival() -> None:
    settings = AppSettings(openai_api_key="test-key")
    running = False
    ensure_calls = 0

    async def ensure_running() -> None:
        nonlocal ensure_calls, running
        ensure_calls += 1
        running = True

    with (
        patch("backend.apps.nine_router.is_running", side_effect=lambda: running),
        patch("backend.apps.nine_router.ensure_running", ensure_running),
        patch(
            "backend.apps.nine_router.process.has_persisted_connections",
            return_value=False,
        ),
    ):
        assert asyncio.run(provider_env.router_available(settings)) is True

    assert ensure_calls == 1


def test_custom_provider_starts_router_and_normalizes_base_url() -> None:
    settings = AppSettings()
    session = AgentSession(name="custom route", model="custom-model")
    options: dict = {}
    running = False
    ensure_calls = 0

    async def ensure_running() -> None:
        nonlocal ensure_calls, running
        ensure_calls += 1
        running = True

    custom_provider = SimpleNamespace(api_key="", base_url="http://model.test/v1/")
    with (
        patch("backend.apps.nine_router.is_running", side_effect=lambda: running),
        patch("backend.apps.nine_router.ensure_running", ensure_running),
        patch(
            "backend.apps.nine_router.normalize_openai_compat_base_url",
            return_value="http://model.test",
        ) as normalize,
        patch(
            "backend.apps.agents.providers.registry.find_builtin_model",
            return_value={"route": "api", "api": "custom"},
        ),
        patch(
            "backend.apps.agents.providers.registry.find_custom_provider_for_value",
            return_value=custom_provider,
        ),
    ):
        asyncio.run(
            provider_env.configure_provider_env(
                options, session, "custom-model", "anthropic", settings
            )
        )

    assert ensure_calls == 1
    normalize.assert_called_once_with("http://model.test/v1/")
    assert options["env"]["OPENAI_API_KEY"] == "no-auth-required"
    assert options["env"]["OPENAI_BASE_URL"] == "http://model.test"


def test_openrouter_starts_router_before_building_environment() -> None:
    settings = AppSettings(openrouter_api_key="openrouter-key")
    session = AgentSession(name="openrouter route", model="openrouter/model")
    options: dict = {}
    running = False
    ensure_calls = 0

    async def ensure_running() -> None:
        nonlocal ensure_calls, running
        ensure_calls += 1
        running = True

    with (
        patch("backend.apps.nine_router.is_running", side_effect=lambda: running),
        patch("backend.apps.nine_router.ensure_running", ensure_running),
        patch(
            "backend.apps.agents.providers.registry.find_builtin_model",
            return_value=None,
        ),
    ):
        asyncio.run(
            provider_env.configure_provider_env(
                options, session, "openrouter/model", "openrouter", settings
            )
        )

    assert ensure_calls == 1
    assert options["env"]["ANTHROPIC_API_KEY"] == "9router"
    assert options["env"]["ANTHROPIC_BASE_URL"] == "http://localhost:20128"


def test_cloud_proxy_uses_resolved_proxy_credentials() -> None:
    settings = AppSettings(
        connection_mode="openswarm-pro",
        openswarm_bearer_token="stored-token",
    )
    session = AgentSession(name="cloud route", model="sonnet")
    options: dict = {}

    with (
        patch(
            "backend.apps.agents.providers.registry.find_builtin_model",
            return_value=None,
        ),
        patch(
            "backend.apps.settings.credentials.proxy_auth",
            return_value=("resolved-token", "https://proxy.test"),
        ) as proxy_auth,
    ):
        asyncio.run(
            provider_env.configure_provider_env(
                options, session, "claude-sonnet", "anthropic", settings
            )
        )

    proxy_auth.assert_called_once_with(settings)
    assert options["env"]["ANTHROPIC_AUTH_TOKEN"] == "resolved-token"
    assert options["env"]["ANTHROPIC_BASE_URL"] == "https://proxy.test"


def test_cloud_proxy_accepts_an_explicit_runtime_boundary() -> None:
    app_settings = AppSettings(connection_mode="openswarm-pro")
    session = AgentSession(name="injected cloud route", model="sonnet")
    options: dict = {}

    class Runtime:
        def router_is_running(self) -> bool:
            raise AssertionError("cloud proxy route must not inspect 9Router")

        async def ensure_router_running(self) -> None:
            raise AssertionError("cloud proxy route must not start 9Router")

        def has_persisted_connections(self) -> bool:
            raise AssertionError("cloud proxy route must not inspect router storage")

        def normalize_openai_compat_base_url(self, base_url: str) -> str:
            raise AssertionError("cloud proxy route must not normalize custom URLs")

        def proxy_auth(
            self, settings: AppSettings
        ) -> tuple[str | None, str | None]:
            assert settings is app_settings
            return "injected-token", "https://injected.test"

    with patch(
        "backend.apps.agents.providers.registry.find_builtin_model",
        return_value=None,
    ):
        asyncio.run(
            provider_env.configure_provider_env(
                options,
                session,
                "claude-sonnet",
                "anthropic",
                app_settings,
                Runtime(),
            )
        )

    assert options["env"]["ANTHROPIC_AUTH_TOKEN"] == "injected-token"
    assert options["env"]["ANTHROPIC_BASE_URL"] == "https://injected.test"
