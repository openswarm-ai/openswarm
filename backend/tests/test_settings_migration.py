"""Upgrade/migration robustness for settings.json: a user who upgrades from an
older app version (legacy field names, removed fields, a field whose type drifted,
a retired Literal value, or an outright corrupt file) must still boot. load_settings
is called at startup, by GET /api/settings, and on every agent dispatch, so a raise
here bricks the whole app. These tests pin both the migration mapping and the
never-raise contract, and assert install-id / first_opened_at continuity."""
import json
import os

import pytest

from backend.apps.settings import store
from backend.apps.settings.models import AppSettings, DEFAULT_SYSTEM_PROMPT


@pytest.fixture
def settings_file(tmp_path, monkeypatch):
    """Point the store at an isolated settings.json under tmp_path."""
    f = str(tmp_path / "settings.json")
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(store, "SETTINGS_FILE", f)
    return f


def p_write(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


# ---------------- migrate_legacy_fields ----------------

def test_migrate_managed_to_openswarm_pro():
    assert store.migrate_legacy_fields({"connection_mode": "managed"})["connection_mode"] == "openswarm-pro"


def test_migrate_auth_token_renamed_and_popped():
    out = store.migrate_legacy_fields({"openswarm_auth_token": "tok"})
    assert out["openswarm_bearer_token"] == "tok"
    assert "openswarm_auth_token" not in out


def test_migrate_does_not_clobber_existing_bearer():
    out = store.migrate_legacy_fields({"openswarm_auth_token": "old", "openswarm_bearer_token": "new"})
    assert out["openswarm_bearer_token"] == "new"


def test_migrate_leaves_modern_values_untouched():
    out = store.migrate_legacy_fields({"connection_mode": "own_key"})
    assert out["connection_mode"] == "own_key"


# ---------------- load_settings: happy paths ----------------

def test_no_file_returns_defaults(settings_file):
    s = store.load_settings()
    assert isinstance(s, AppSettings)
    assert s.default_system_prompt == DEFAULT_SYSTEM_PROMPT
    assert s.theme == "dark"


def test_minimal_old_file_fills_missing_with_defaults(settings_file):
    # An old build wrote only a couple of fields; everything else must default.
    p_write(settings_file, {"theme": "light"})
    s = store.load_settings()
    assert s.theme == "light"
    assert s.default_model == "sonnet"  # filled from default
    assert s.auto_reveal_sub_agents is True


def test_legacy_fields_migrated_end_to_end(settings_file):
    p_write(settings_file, {"connection_mode": "managed", "openswarm_auth_token": "tok"})
    s = store.load_settings()
    assert s.connection_mode == "openswarm-pro"
    assert s.openswarm_bearer_token == "tok"


def test_install_id_and_first_opened_continuity(settings_file):
    # The identity carried across upgrades must survive a load untouched.
    p_write(settings_file, {"installation_id": "abc-123", "first_opened_at": "2025-01-01T00:00:00Z"})
    s = store.load_settings()
    assert s.installation_id == "abc-123"
    assert s.first_opened_at == "2025-01-01T00:00:00Z"


def test_null_system_prompt_backfilled(settings_file):
    p_write(settings_file, {"default_system_prompt": None})
    assert store.load_settings().default_system_prompt == DEFAULT_SYSTEM_PROMPT


# ---------------- load_settings: forward/backward-compat robustness ----------------

def test_unknown_removed_fields_are_ignored(settings_file):
    # A field that existed in a future/older schema but not this one must not crash.
    p_write(settings_file, {"theme": "light", "a_field_we_removed": 999, "another_ghost": {"x": 1}})
    s = store.load_settings()
    assert s.theme == "light"


def test_type_drifted_field_reverts_to_default_keeps_rest(settings_file):
    # dismissed_mcp_suggestions is dict[str,str] now; an old build stored a list. The bad field must revert to its default, every valid field must survive.
    p_write(settings_file, {"theme": "light", "dismissed_mcp_suggestions": ["legacy", "list"]})
    s = store.load_settings()
    assert s.theme == "light"
    assert s.dismissed_mcp_suggestions == {}


def test_retired_literal_value_reverts_to_default(settings_file):
    # default_thinking_level is a Literal; a retired value must not brick load.
    p_write(settings_file, {"theme": "light", "default_thinking_level": "ultra"})
    s = store.load_settings()
    assert s.theme == "light"
    assert s.default_thinking_level == "auto"


def test_multiple_bad_fields_all_revert_valid_survive(settings_file):
    p_write(settings_file, {
        "theme": "light",
        "default_thinking_level": "ultra",       # retired literal
        "dismissed_mcp_suggestions": [1, 2, 3],   # wrong type
        "zoom_sensitivity": "not-a-number",       # wrong type
    })
    s = store.load_settings()
    assert s.theme == "light"
    assert s.default_thinking_level == "auto"
    assert s.dismissed_mcp_suggestions == {}
    assert s.zoom_sensitivity == 50.0


def test_corrupt_json_returns_defaults_and_preserves_file(settings_file):
    with open(settings_file, "w", encoding="utf-8") as fh:
        fh.write("{ this is : not json ,,, ")
    s = store.load_settings()
    assert s.theme == "dark"  # defaults
    # Original is moved aside (recoverable), not silently destroyed.
    assert os.path.exists(settings_file + ".corrupt")
    assert not os.path.exists(settings_file)


def test_non_dict_top_level_returns_defaults(settings_file):
    p_write(settings_file, ["not", "an", "object"])
    s = store.load_settings()
    assert s.theme == "dark"
    assert os.path.exists(settings_file + ".corrupt")


# ---------------- round-trip ----------------

def test_save_then_load_roundtrip(settings_file):
    s = AppSettings(theme="light", default_model="opus", installation_id="keep-me")
    store.save_settings(s)
    loaded = store.load_settings()
    assert loaded.theme == "light"
    assert loaded.default_model == "opus"
    assert loaded.installation_id == "keep-me"
