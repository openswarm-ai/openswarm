"""The no-suicide invariant for the agent-editable settings tool, proved by
exhaustive enumeration rather than a few hand-picked cases.

The state space here is small and finite (every shipped model row x every
connection mode x which keys are present), so we walk ALL of it deterministically
instead of reaching for randomized property testing. A failure is a concrete,
reproducible (model, mode, keys) tuple, not a flaky seed.

The one invariant under test: the settings-meta write guard must NEVER let an
agent blank the credential powering its own run, while still allowing it to
clear any OTHER provider's key. Plus two drift seals: every shipped model lane
classifies (no "unknown"), and the redactor catches every credential field.
"""

from __future__ import annotations

import itertools

import pytest

from backend.apps.settings.models import AppSettings, CustomProvider
from backend.apps.agents.providers.registry import BUILTIN_MODELS
from backend.apps.agents.session_credential import (
    ALL_API_KEY_FIELDS,
    resolve_powering_credential,
    write_would_suicide,
)
from backend.apps.settings.redaction import is_secret_field, redact_settings


CONNECTION_MODES = ["own_key", "openswarm-pro", "free-trial"]

# Every credential field the settings PUT path already treats as secret. Kept here as the contract the redactor must honor; if PUT's notion of "secret" grows, this list should too, and the drift-seal test fails until the redactor also covers it.
KNOWN_SECRET_FIELDS = [
    "anthropic_api_key", "openai_api_key", "google_api_key", "openrouter_api_key",
    "claude_subscription_token", "openai_subscription_token", "gemini_subscription_token",
    "openswarm_bearer_token", "free_trial_token", "installation_id",
]


def p_all_model_values() -> list[str]:
    vals = [m["value"] for rows in BUILTIN_MODELS.values() for m in rows]
    # Plus synthesized lanes the resolver must also place.
    vals += ["or:anthropic/claude-3.5", "custom/lmstudio/llama-3", "totally-made-up-model"]
    return vals


def p_settings_with(mode: str, keys: set[str], custom: bool = False) -> AppSettings:
    s = AppSettings(connection_mode=mode)
    if "anthropic" in keys:
        s.anthropic_api_key = "sk-ant-live-aaaa"
    if "openai" in keys:
        s.openai_api_key = "sk-openai-live-bbbb"
    if "google" in keys:
        s.google_api_key = "goog-live-cccc"
    if "openrouter" in keys:
        s.openrouter_api_key = "or-live-dddd"
    if mode in ("openswarm-pro", "free-trial"):
        s.openswarm_bearer_token = "bearer-live-eeee"
        if mode == "free-trial":
            s.free_trial_token = "ft-live-ffff"
    if custom:
        s.custom_providers = [CustomProvider(name="LMStudio", base_url="http://localhost:1234/v1", api_key="local")]
    return s


# --------------------------------------------------------------------------- The invariant: the live credential can never be blanked; others always can. ---------------------------------------------------------------------------

def test_live_api_key_can_never_be_blanked_but_others_can():
    key_subsets = [set(c) for r in range(5)
                   for c in itertools.combinations(["anthropic", "openai", "google", "openrouter"], r)]
    checked_api_key_runs = 0
    for model in p_all_model_values():
        for mode in CONNECTION_MODES:
            for keys in key_subsets:
                for custom in (False, True):
                    s = p_settings_with(mode, keys, custom=custom)
                    p = resolve_powering_credential(model, s)

                    if p.kind == "api_key" and p.protected_field:
                        checked_api_key_runs += 1
                        # Blanking the live key, in any blank form, is refused.
                        for blank in (None, "", "   "):
                            assert write_would_suicide(p.protected_field, blank, p), (
                                f"suicide allowed: model={model} mode={mode} field={p.protected_field}={blank!r}"
                            )
                        # Replacing it with a real key is a reconnect, allowed.
                        assert not write_would_suicide(p.protected_field, "sk-fresh-9999", p)
                        # Clearing any OTHER provider's key stays allowed.
                        for other in ALL_API_KEY_FIELDS - {p.protected_field}:
                            assert not write_would_suicide(other, "", p), (
                                f"over-blocked unrelated key {other}: model={model} mode={mode}"
                            )

                    elif p.kind == "subscription":
                        # The live credential isn't a settings field, so clearing ANY api key is safe (it can't be the powering one).
                        for field in ALL_API_KEY_FIELDS:
                            assert not write_would_suicide(field, "", p), (
                                f"subscription run wrongly protected {field}: model={model} mode={mode}"
                            )

                    elif p.kind == "unknown":
                        # Fail safe: every credential field is protected.
                        for field in ALL_API_KEY_FIELDS:
                            assert write_would_suicide(field, "", p)

    assert checked_api_key_runs > 0, "enumeration never exercised an api-key run; test is vacuous"


def test_custom_provider_run_protects_its_entry():
    s = p_settings_with("own_key", set(), custom=True)
    p = resolve_powering_credential("custom/lmstudio/llama-3", s)
    assert p.kind == "api_key" and p.provider == "custom"

    # Dropping the powering provider's entry is suicide.
    assert write_would_suicide("custom_providers", [], p)
    # Keeping it (even with a blanked placeholder key, local servers don't need one) is fine.
    keep = [{"name": "LMStudio", "base_url": "http://localhost:1234/v1", "api_key": ""}]
    assert not write_would_suicide("custom_providers", keep, p)
    # Swapping in a different provider but losing the live one is suicide.
    other = [{"name": "Together", "base_url": "https://api.together.xyz/v1", "api_key": "k"}]
    assert write_would_suicide("custom_providers", other, p)


def test_disconnect_all_models_spec_scenario():
    """The spec's worked example: Claude (api key) + OpenAI (api key) both
    connected, run on an Anthropic model, asked to disconnect everything. It
    must refuse to kill Claude (the live one) and allow killing OpenAI."""
    s = p_settings_with("own_key", {"anthropic", "openai"})
    p = resolve_powering_credential("opus-4-8", s)  # default Anthropic row, own_key -> api key
    assert p.kind == "api_key" and p.protected_field == "anthropic_api_key"
    assert write_would_suicide("anthropic_api_key", "", p)        # refuse self
    assert not write_would_suicide("openai_api_key", "", p)       # allow the other

    # Same connections, but the run is on the OpenAI key instead: mirror image.
    p2 = resolve_powering_credential("gpt-5.5-api", s)
    assert p2.kind == "api_key" and p2.protected_field == "openai_api_key"
    assert write_would_suicide("openai_api_key", "", p2)
    assert not write_would_suicide("anthropic_api_key", "", p2)


# --------------------------------------------------------------------------- Drift seals. ---------------------------------------------------------------------------

def test_every_shipped_model_lane_classifies():
    """A new model row that the resolver can't place would silently fall to the
    fail-safe 'unknown' lane (over-blocking every key). Force every shipped row
    to resolve to a real api_key/subscription so new lanes get classified."""
    s_pro = p_settings_with("openswarm-pro", {"anthropic", "openai", "google", "openrouter"})
    s_key = p_settings_with("own_key", {"anthropic", "openai", "google", "openrouter"})
    for rows in BUILTIN_MODELS.values():
        for m in rows:
            for s in (s_pro, s_key):
                p = resolve_powering_credential(m["value"], s)
                assert p.kind in ("api_key", "subscription"), (
                    f"unclassified model lane {m['value']!r} -> {p.kind}"
                )


def test_redactor_catches_every_known_secret():
    for field in KNOWN_SECRET_FIELDS:
        assert is_secret_field(field), f"redactor would leak {field}"
    # And every AppSettings field that NAMES itself a secret is caught by the rule.
    for name in AppSettings.model_fields:
        if name.endswith(("_key", "_token", "_secret")):
            assert is_secret_field(name)


def test_redaction_fail_safe_catches_misnamed_secret_by_value():
    # The name rule (_key/_token/_secret) would MISS a field named off-convention. The value-shape backstop must still redact it, so a leak needs BOTH a bad name AND a non-credential-shaped value, not just one.
    import json
    raw = {"theme": "dark", "weird_field": "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF"}
    red = redact_settings(raw)
    assert red["theme"] == "dark"
    assert isinstance(red["weird_field"], dict) and red["weird_field"]["configured"] is True
    assert "sk-ant-api03" not in json.dumps(red)


def test_redact_settings_never_emits_a_raw_secret():
    s = p_settings_with("openswarm-pro", {"anthropic", "openai", "google", "openrouter"}, custom=True)
    s.claude_subscription_token = "should-never-appear"
    raw = s.model_dump()
    red = redact_settings(raw)

    for field in KNOWN_SECRET_FIELDS:
        if field in red:
            assert isinstance(red[field], dict), f"{field} not redacted to a state dict"
            assert "configured" in red[field]
            raw_val = raw.get(field)
            if isinstance(raw_val, str) and raw_val.strip():
                # Configured: state only, never the whole value (last4 at most).
                assert red[field]["configured"] is True
                assert red[field].get("last4") != raw_val
                assert len(red[field].get("last4") or "") <= 4
    # The nested custom-provider key is redacted too.
    assert isinstance(red["custom_providers"][0]["api_key"], dict)
    # Non-secret fields pass through untouched.
    assert red["theme"] == raw["theme"]
    assert red["connection_mode"] == raw["connection_mode"]

    # The strongest check: the literal secret string appears nowhere in the output.
    import json
    assert "should-never-appear" not in json.dumps(red)
    assert "sk-ant-live-aaaa" not in json.dumps(red)
