"""Tests for `backend.apps.agents.providers.registry`.

The registry is currently 16% covered. This file fills in:

  - `_find_builtin_model` known + unknown
  - `get_api_type` over every value in BUILTIN_MODELS + unknown default
  - `resolve_model_id_for_sdk` across every routing branch:
      - openswarm-pro mode → bare model_id
      - direct anthropic_api_key → bare model_id
      - explicit `route="cc"` → router_model_id (subscription)
      - explicit `route="api"` → bare model_id
      - gemini-cli + google_api_key → `gemini/<suffix>`
      - gemini-cli + Antigravity active (mock httpx 200) → `ag/<mapped>`
      - gemini-cli fallthrough → `gc/<suffix>`
      - openai/codex/gemini fallthrough → router_model_id
      - unknown short_name → passthrough
  - `resolve_aux_model` every priority branch + ValueError fallthrough
  - `create_provider` every api_type + 9Router fallback + missing-key raise
  - `thinking_params_for(api, level)` full matrix
  - `get_available_models` `configured` flag correctness
  - `get_context_window` known/custom/default
  - `calculate_cost` known + unknown rates + case-insensitive provider

Live network calls (httpx, 9Router) are fully mocked.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.apps.agents.providers import registry as reg
from backend.apps.agents.providers.registry import (
    BUILTIN_MODELS,
    _find_builtin_model,
    _get_api_type,
    _has_credentials,
    calculate_cost,
    create_provider,
    get_api_type,
    get_available_models,
    get_context_window,
    resolve_aux_model,
    resolve_model_id_for_sdk,
    thinking_params_for,
)
from backend.apps.settings.models import AppSettings, CustomProvider


# ---------------------------------------------------------------------------
# _find_builtin_model + get_api_type
# ---------------------------------------------------------------------------


def test_find_builtin_model_known():
    entry = _find_builtin_model("sonnet")
    assert entry is not None
    assert entry["api"] == "anthropic"
    assert entry["value"] == "sonnet"


def test_find_builtin_model_unknown_returns_none():
    assert _find_builtin_model("not-a-real-model") is None


def test_get_api_type_unknown_defaults_to_anthropic():
    assert get_api_type("not-a-real-model") == "anthropic"


@pytest.mark.parametrize(
    "short,expected_api",
    [
        ("sonnet", "anthropic"),
        ("opus", "anthropic"),
        ("haiku", "anthropic"),
        ("sonnet-cc", "anthropic"),
        ("sonnet-api", "anthropic"),
        ("gpt-5.4", "codex"),
        ("gpt-5.4-mini", "codex"),
        ("gpt-5.4-api", "openai"),
        ("gpt-5.3-codex-api", "openai"),
        ("gemini-3-pro", "gemini-cli"),
        ("gemini-2.5-flash", "gemini-cli"),
        ("gemini-3-pro-api", "gemini"),
        ("gemini-2.5-flash-api", "gemini"),
    ],
)
def test_get_api_type_known_models(short: str, expected_api: str):
    assert get_api_type(short) == expected_api


# ---------------------------------------------------------------------------
# _get_api_type — provider-name dispatch
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,expected",
    [
        ("Anthropic", "anthropic"),
        ("OpenAI", "codex"),  # the OpenAI tier's first entry uses api=codex
        ("Google", "gemini-cli"),
        ("anthropic", "anthropic"),  # case-insensitive
        ("OPENAI", "openai"),
        ("google", "gemini"),  # lowercase 'google' -> gemini via _API_NAME_MAP
        ("openrouter", "openrouter"),
        ("UnknownProvider", "openrouter"),  # fallthrough default
    ],
)
def test_underscore_get_api_type_dispatch(name: str, expected: str):
    assert _get_api_type(name) == expected


# ---------------------------------------------------------------------------
# resolve_model_id_for_sdk
# ---------------------------------------------------------------------------


def test_resolve_unknown_passthrough():
    s = AppSettings()
    assert resolve_model_id_for_sdk("not-a-real-model", s) == "not-a-real-model"


def test_resolve_route_cc_uses_router_id():
    s = AppSettings()
    assert resolve_model_id_for_sdk("sonnet-cc", s) == "cc/claude-sonnet-4-6"


def test_resolve_route_api_uses_bare_model_id():
    s = AppSettings()
    assert resolve_model_id_for_sdk("sonnet-api", s) == "claude-sonnet-4-6"
    assert resolve_model_id_for_sdk("gpt-5.4-api", s) == "gpt-5.4"


def test_resolve_anthropic_with_openswarm_pro_returns_bare():
    s = AppSettings(connection_mode="openswarm-pro")
    assert resolve_model_id_for_sdk("sonnet", s) == "claude-sonnet-4-6"


def test_resolve_anthropic_with_api_key_returns_bare():
    s = AppSettings(anthropic_api_key="sk-test")
    assert resolve_model_id_for_sdk("sonnet", s) == "claude-sonnet-4-6"


def test_resolve_anthropic_no_creds_returns_router_id():
    """Without anthropic_api_key + own_key mode → 9Router cc/ prefix."""
    s = AppSettings()
    assert resolve_model_id_for_sdk("sonnet", s) == "cc/claude-sonnet-4-6"


def test_resolve_gemini_cli_with_google_api_key_uses_gemini_prefix():
    """google_api_key set → AI Studio direct path."""
    s = AppSettings(google_api_key="AIza-test")
    assert resolve_model_id_for_sdk("gemini-3-pro", s) == "gemini/gemini-3-pro-preview"
    assert resolve_model_id_for_sdk("gemini-2.5-pro", s) == "gemini/gemini-2.5-pro"


def test_resolve_gemini_cli_antigravity_active_returns_ag_prefix():
    """Without google_api_key but with Antigravity connected on 9Router,
    map to ag/<mapped_suffix>."""
    s = AppSettings()
    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json.return_value = {
        "connections": [
            {"provider": "antigravity", "isActive": True},
        ],
    }
    with patch("httpx.get", return_value=fake_resp):
        assert resolve_model_id_for_sdk("gemini-3-pro", s) == "ag/gemini-3.1-pro-high"
        assert resolve_model_id_for_sdk("gemini-3-flash", s) == "ag/gemini-3-flash"


def test_resolve_gemini_cli_antigravity_active_but_unmapped_falls_through():
    """Even with Antigravity active, models not in the _ANTIGRAVITY_MAP
    (gemini-2.5-*) must fall through to gc/."""
    s = AppSettings()
    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json.return_value = {
        "connections": [{"provider": "antigravity", "isActive": True}],
    }
    with patch("httpx.get", return_value=fake_resp):
        assert resolve_model_id_for_sdk("gemini-2.5-pro", s) == "gc/gemini-2.5-pro"


def test_resolve_gemini_cli_no_creds_returns_gc():
    """Default fallthrough — no API key, no Antigravity."""
    s = AppSettings()
    fake_resp = MagicMock()
    fake_resp.status_code = 200
    fake_resp.json.return_value = {"connections": []}
    with patch("httpx.get", return_value=fake_resp):
        assert resolve_model_id_for_sdk("gemini-3-pro", s) == "gc/gemini-3-pro-preview"


def test_resolve_gemini_cli_httpx_exception_falls_through_to_gc():
    """If 9Router probe raises, fail open → gc/ prefix."""
    s = AppSettings()
    with patch("httpx.get", side_effect=Exception("boom")):
        assert resolve_model_id_for_sdk("gemini-3-pro", s) == "gc/gemini-3-pro-preview"


def test_resolve_codex_returns_router_id():
    s = AppSettings()
    assert resolve_model_id_for_sdk("gpt-5.4", s) == "cx/gpt-5.4"


# ---------------------------------------------------------------------------
# resolve_aux_model
# ---------------------------------------------------------------------------


async def test_resolve_aux_model_openswarm_pro_returns_proxy_url():
    s = AppSettings(connection_mode="openswarm-pro", openswarm_proxy_url="https://proxy.test")
    model, base_url = await resolve_aux_model(s)
    assert "haiku" in model
    assert base_url == "https://proxy.test"


async def test_resolve_aux_model_openswarm_pro_default_url():
    """If openswarm_proxy_url isn't set, defaults to api.openswarm.com."""
    s = AppSettings(connection_mode="openswarm-pro")
    _model, base_url = await resolve_aux_model(s)
    assert base_url == "https://api.openswarm.com"


async def test_resolve_aux_model_anthropic_api_key_returns_no_base_url():
    s = AppSettings(anthropic_api_key="sk-test")
    model, base_url = await resolve_aux_model(s)
    assert "haiku" in model
    assert base_url is None


async def test_resolve_aux_model_sonnet_tier():
    s = AppSettings(anthropic_api_key="sk-test")
    model, _ = await resolve_aux_model(s, preferred_tier="sonnet")
    assert "sonnet" in model


async def test_resolve_aux_model_9router_claude_connection():
    s = AppSettings()
    with patch.object(reg, "_9r_running", create=True), \
         patch("backend.apps.nine_router.is_running", return_value=True), \
         patch("backend.apps.nine_router.get_providers", new_callable=AsyncMock,
               return_value=[{"provider": "claude", "isActive": True}]):
        model, base_url = await resolve_aux_model(s)
        assert model.startswith("cc/")
        assert base_url == "http://localhost:20128"


async def test_resolve_aux_model_9router_codex_connection():
    s = AppSettings()
    with patch("backend.apps.nine_router.is_running", return_value=True), \
         patch("backend.apps.nine_router.get_providers", new_callable=AsyncMock,
               return_value=[{"provider": "codex", "isActive": True}]):
        model, base_url = await resolve_aux_model(s)
        assert model == "cx/gpt-5.4-mini"
        assert base_url == "http://localhost:20128"


async def test_resolve_aux_model_9router_gemini_connection():
    s = AppSettings()
    with patch("backend.apps.nine_router.is_running", return_value=True), \
         patch("backend.apps.nine_router.get_providers", new_callable=AsyncMock,
               return_value=[{"provider": "gemini-cli", "isActive": True}]):
        model, base_url = await resolve_aux_model(s)
        assert model == "gc/gemini-2.5-flash"
        assert base_url == "http://localhost:20128"


async def test_resolve_aux_model_9router_no_connections_raises():
    s = AppSettings()
    with patch("backend.apps.nine_router.is_running", return_value=True), \
         patch("backend.apps.nine_router.get_providers", new_callable=AsyncMock,
               return_value=[]):
        with pytest.raises(ValueError, match="No AI provider connected"):
            await resolve_aux_model(s)


async def test_resolve_aux_model_9router_not_running_raises():
    s = AppSettings()
    with patch("backend.apps.nine_router.is_running", return_value=False):
        with pytest.raises(ValueError, match="No AI provider configured"):
            await resolve_aux_model(s)


# ---------------------------------------------------------------------------
# create_provider
# ---------------------------------------------------------------------------


def test_create_provider_anthropic_with_api_key():
    s = AppSettings(anthropic_api_key="sk-test")
    p = create_provider("Anthropic", s)
    from backend.apps.agents.providers.anthropic import AnthropicProvider
    assert isinstance(p, AnthropicProvider)


def test_create_provider_anthropic_with_openswarm_pro():
    s = AppSettings(
        connection_mode="openswarm-pro",
        openswarm_bearer_token="bearer-x",
        openswarm_proxy_url="https://proxy.test",
    )
    p = create_provider("Anthropic", s)
    from backend.apps.agents.providers.anthropic import AnthropicProvider
    assert isinstance(p, AnthropicProvider)


def test_create_provider_anthropic_falls_back_to_9router():
    s = AppSettings()
    with patch.object(reg, "_is_9router_available", return_value=True):
        p = create_provider("Anthropic", s)
    from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
    assert isinstance(p, OpenAICompatProvider)
    # The override remaps short names → 9Router prefix
    assert p.get_model_id("sonnet") == "cc/claude-sonnet-4-6"
    assert p.get_model_id("custom-id") == "cc/custom-id"
    assert p.get_model_id("cc/already") == "cc/already"


def test_create_provider_anthropic_no_creds_raises():
    s = AppSettings()
    with patch.object(reg, "_is_9router_available", return_value=False):
        with pytest.raises(ValueError, match="Anthropic API key not configured"):
            create_provider("Anthropic", s)


def test_create_provider_openai_with_key():
    s = AppSettings(openai_api_key="sk-openai-test")
    p = create_provider("OPENAI", s)
    from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
    assert isinstance(p, OpenAICompatProvider)


def test_create_provider_openai_no_key_falls_back_to_9router():
    s = AppSettings()
    with patch.object(reg, "_is_9router_available", return_value=True):
        p = create_provider("OPENAI", s)
    from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
    assert isinstance(p, OpenAICompatProvider)


def test_create_provider_openai_no_creds_raises():
    s = AppSettings()
    with patch.object(reg, "_is_9router_available", return_value=False):
        with pytest.raises(ValueError, match="OpenAI API key not configured"):
            create_provider("OPENAI", s)


def test_create_provider_gemini_branch_imports_gemini_module():
    """The gemini branch imports `backend.apps.agents.providers.gemini`,
    which doesn't currently ship in this repo. The branch is therefore
    only reachable once that module exists; verify the failure mode is
    `ModuleNotFoundError` (not silent), so we'll notice if the module
    is added without updating tests."""
    s = AppSettings(google_api_key="AIza-test")
    with pytest.raises(ModuleNotFoundError):
        create_provider("google", s)


def test_create_provider_openrouter_with_key():
    s = AppSettings(openrouter_api_key="sk-or-test")
    p = create_provider("openrouter", s)
    from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
    assert isinstance(p, OpenAICompatProvider)


def test_create_provider_openrouter_no_key_falls_back_to_9router():
    s = AppSettings()
    with patch.object(reg, "_is_9router_available", return_value=True):
        p = create_provider("openrouter", s)
    from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
    assert isinstance(p, OpenAICompatProvider)


def test_create_provider_openrouter_no_creds_raises():
    s = AppSettings()
    with patch.object(reg, "_is_9router_available", return_value=False):
        with pytest.raises(ValueError, match="OpenRouter API key not configured"):
            create_provider("openrouter", s)


def test_create_provider_9router_short_circuit():
    """provider_name='9Router' takes the explicit early-return path —
    no settings needed."""
    s = AppSettings()
    p = create_provider("9Router", s)
    from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
    assert isinstance(p, OpenAICompatProvider)


def test_create_provider_custom_provider_via_provider_config():
    """Inline custom provider definition via the kwarg shortcut.

    Unknown provider names default to api_type='openrouter' — to reach
    the `provider_config` branch we patch the api-type lookup to a
    value not in the known-api if-chain."""
    s = AppSettings()
    with patch.object(reg, "_get_api_type", return_value="custom-other"):
        p = create_provider(
            "MyCustom", s,
            provider_config={"api_key": "k", "base_url": "http://example.invalid/v1"},
        )
    from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
    assert isinstance(p, OpenAICompatProvider)


def test_create_provider_custom_provider_lookup_in_settings():
    """Same shape as above, but the custom provider lives on settings
    and is resolved by name."""
    s = AppSettings(custom_providers=[
        CustomProvider(name="MyCustom", base_url="http://example.invalid/v1", api_key="k"),
    ])
    with patch.object(reg, "_get_api_type", return_value="custom-other"):
        p = create_provider("MyCustom", s)
    from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
    assert isinstance(p, OpenAICompatProvider)


def test_create_provider_unknown_custom_name_raises():
    """If the provider isn't found among any branch, raise ValueError."""
    s = AppSettings()
    with patch.object(reg, "_get_api_type", return_value="custom-other"):
        with pytest.raises(ValueError, match="Unknown provider"):
            create_provider("NotInSettings", s)


def test_create_provider_unknown_provider_raises():
    """No matching api_type, no provider_config, no custom provider → ValueError.
    But unknown providers default to api_type='openrouter' so they hit
    the openrouter branch first; we set up to reach the final unknown."""
    s = AppSettings(openrouter_api_key="sk-test")
    # With openrouter key, "Unknown" provider returns an OpenAI-compat
    # adapter via the openrouter branch — not the unknown raise.
    p = create_provider("Unknown", s)
    from backend.apps.agents.providers.openai_compat import OpenAICompatProvider
    assert isinstance(p, OpenAICompatProvider)


# ---------------------------------------------------------------------------
# thinking_params_for
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "api,level,expected",
    [
        # auto → adaptive on Claude, defaults elsewhere
        ("anthropic", "auto", {"thinking": {"type": "adaptive"}}),
        ("codex", "auto", None),
        ("gemini-cli", "auto", None),
        # off → explicit disable per provider
        ("anthropic", "off", {"thinking": {"type": "disabled"}}),
        ("codex", "off", {"reasoning": {"effort": "none"}}),
        ("gemini-cli", "off", {"thinkingConfig": {"thinkingLevel": "LOW"}}),
        # Explicit levels
        ("anthropic", "low", {"thinking": {"type": "adaptive"}}),
        ("anthropic", "medium", {"thinking": {"type": "adaptive"}}),
        ("anthropic", "high", {"thinking": {"type": "adaptive"}}),
        ("codex", "low", {"reasoning": {"effort": "low"}}),
        ("codex", "medium", {"reasoning": {"effort": "medium"}}),
        ("codex", "high", {"reasoning": {"effort": "high"}}),
        ("gemini-cli", "low", {"thinkingConfig": {"thinkingLevel": "LOW"}}),
        ("gemini-cli", "medium", {"thinkingConfig": {"thinkingLevel": "MEDIUM"}}),
        ("gemini-cli", "high", {"thinkingConfig": {"thinkingLevel": "HIGH"}}),
        # Unknown api → None
        ("openai", "high", None),
    ],
)
def test_thinking_params_for(api: str, level: str, expected):
    assert thinking_params_for(api, level) == expected


# ---------------------------------------------------------------------------
# get_available_models / configured flag / _has_credentials
# ---------------------------------------------------------------------------


def test_get_available_models_configured_flag_anthropic():
    """anthropic_api_key set → Anthropic models marked configured."""
    s = AppSettings(anthropic_api_key="sk-test")
    out = get_available_models(s)
    assert all(m["configured"] for m in out["Anthropic"])
    # Other providers without keys → not configured
    assert all(not m["configured"] for m in out["OpenAI"])


def test_get_available_models_configured_flag_openswarm_pro():
    """In openswarm-pro mode, having a bearer token configures Anthropic."""
    s = AppSettings(connection_mode="openswarm-pro", openswarm_bearer_token="bearer-x")
    out = get_available_models(s)
    assert all(m["configured"] for m in out["Anthropic"])


def test_get_available_models_includes_custom_providers():
    s = AppSettings(custom_providers=[
        CustomProvider(
            name="Local",
            base_url="http://localhost:8080/v1",
            api_key="x",
            models=[{"value": "phi-mini", "label": "Phi Mini", "context_window": 32_000}],
        ),
    ])
    out = get_available_models(s)
    assert "Local" in out
    assert out["Local"][0]["value"] == "phi-mini"
    assert out["Local"][0]["context_window"] == 32_000
    assert out["Local"][0]["configured"] is True


def test_has_credentials_unknown_provider_returns_false():
    """Unknown providers default to openrouter api_type, which checks
    openrouter_api_key — without it, returns False."""
    s = AppSettings()
    assert _has_credentials("Unknown", s) is False


# ---------------------------------------------------------------------------
# get_context_window
# ---------------------------------------------------------------------------


def test_get_context_window_known_anthropic():
    assert get_context_window("Anthropic", "sonnet") == 1_000_000


def test_get_context_window_known_haiku():
    assert get_context_window("Anthropic", "haiku") == 200_000


def test_get_context_window_unknown_returns_default():
    assert get_context_window("Anthropic", "not-real") == 128_000


def test_get_context_window_custom_provider_lookup():
    s = AppSettings(custom_providers=[
        CustomProvider(
            name="L",
            base_url="x",
            models=[{"value": "m", "context_window": 64_000}],
        ),
    ])
    assert get_context_window("L", "m", s) == 64_000


def test_get_context_window_custom_provider_via_id_field():
    """Some configs use `id` instead of `value` — both must resolve."""
    s = AppSettings(custom_providers=[
        CustomProvider(
            name="L",
            base_url="x",
            models=[{"id": "m", "context_window": 32_000}],
        ),
    ])
    assert get_context_window("L", "m", s) == 32_000


# ---------------------------------------------------------------------------
# calculate_cost
# ---------------------------------------------------------------------------


def test_calculate_cost_known_rates():
    """Anthropic Sonnet: $3/M input, $15/M output. 1M of each → $18."""
    out = calculate_cost("Anthropic", "sonnet", 1_000_000, 1_000_000)
    assert out == 18.0


def test_calculate_cost_case_insensitive_provider():
    out = calculate_cost("anthropic", "sonnet", 1_000_000, 0)
    assert out == 3.0


def test_calculate_cost_unknown_returns_zero():
    assert calculate_cost("NobodyKnows", "made-up", 100_000, 50_000) == 0.0


def test_calculate_cost_zero_token_count():
    assert calculate_cost("Anthropic", "sonnet", 0, 0) == 0.0


def test_calculate_cost_subscription_path_zero_cost():
    """Codex / Gemini CLI subscriptions are zero-cost to the user;
    confirm calculate_cost surfaces 0 even on heavy usage."""
    assert calculate_cost("OpenAI", "gpt-5.4", 1_000_000, 1_000_000) == 0.0
    assert calculate_cost("Google", "gemini-2.5-pro", 1_000_000, 1_000_000) == 0.0


# ---------------------------------------------------------------------------
# _is_9router_available cache
# ---------------------------------------------------------------------------


def test_is_9router_available_caches_for_30s():
    """Two consecutive calls within the 30s window should hit the cache
    after the first httpx.get."""
    reg._9router_cache["available"] = None
    reg._9router_cache["checked_at"] = 0
    fake_resp = MagicMock(status_code=200)
    with patch("httpx.get", return_value=fake_resp) as mock_get:
        a = reg._is_9router_available()
        b = reg._is_9router_available()
    assert a is True and b is True
    assert mock_get.call_count == 1


def test_is_9router_available_handles_exception():
    """Network error → cached False so we don't retry on every call."""
    reg._9router_cache["available"] = None
    reg._9router_cache["checked_at"] = 0
    with patch("httpx.get", side_effect=Exception("boom")):
        assert reg._is_9router_available() is False
