"""Smoke tests for /api/settings.

Settings are the single AppSettings document persisted at
`<DATA_ROOT>/settings/settings.json`. The PUT handler also fans out to
9Router sync (mocked in conftest) and PostHog analytics, neither of
which we exercise here.

Tests:
  - GET /api/settings returns defaults including the canned system prompt
  - PUT /api/settings round-trips a value and survives `load_settings()` reload
  - reset-system-prompt
  - browse-directories on a tmp dir
"""

from __future__ import annotations

import os


def test_get_returns_defaults(client):
    resp = client.get("/api/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["default_model"] == "sonnet"
    assert body["default_mode"] == "agent"
    assert body["default_system_prompt"]  # populated from DEFAULT_SYSTEM_PROMPT


def test_put_round_trips_value(client):
    """PUT a sentinel theme; GET must echo it back, AND the on-disk
    record must reflect it (catches accidental write-only-in-memory
    regressions in `save_settings_async`)."""
    current = client.get("/api/settings").json()
    current["theme"] = "light"

    put = client.put("/api/settings", json=current)
    assert put.status_code == 200
    assert put.json()["settings"]["theme"] == "light"

    refetched = client.get("/api/settings").json()
    assert refetched["theme"] == "light"

    # And confirm the persistence layer (not just the in-memory cache).
    from backend.apps.settings.settings import load_settings

    assert load_settings().theme == "light"


def test_reset_system_prompt(client):
    """Mutate then reset; the prompt must snap back to DEFAULT_SYSTEM_PROMPT."""
    from backend.apps.settings.models import DEFAULT_SYSTEM_PROMPT

    current = client.get("/api/settings").json()
    current["default_system_prompt"] = "MUTATED"
    client.put("/api/settings", json=current)

    resp = client.post("/api/settings/reset-system-prompt")
    assert resp.status_code == 200
    assert resp.json()["settings"]["default_system_prompt"] == DEFAULT_SYSTEM_PROMPT


def test_browse_directories_lists_tmp(client, tmp_path):
    """Drop a known file/dir into pytest's tmp_path and assert it shows up."""
    (tmp_path / "subdir").mkdir()
    (tmp_path / "hello.txt").write_text("hi")

    resp = client.get(
        "/api/settings/browse-directories",
        params={"path": str(tmp_path)},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["current"] == os.path.abspath(str(tmp_path))
    assert "subdir" in body["directories"]
    assert "hello.txt" in body["files"]


def test_browse_directories_404_on_missing_path(client, tmp_path):
    resp = client.get(
        "/api/settings/browse-directories",
        params={"path": str(tmp_path / "does-not-exist")},
    )
    assert resp.status_code == 404
