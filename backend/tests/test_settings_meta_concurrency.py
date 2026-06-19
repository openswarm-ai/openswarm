"""Concurrent SettingsWrite must not lose updates.

SettingsWrite is a read-modify-write that routes through update_settings (which
awaits), so two autonomous agents writing at the same time would interleave: each
loads the same snapshot, each writes the WHOLE object back, and the last writer
silently reverts the other's field, while BOTH agents are told "applied". This
drives two genuinely concurrent writes (different fields) through the ASGI app
and asserts neither is lost. It's the regression guard for the asyncio lock that
serializes these writes; without the lock this fails reproducibly.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from backend.main import app


def _auth_headers():
    import backend.auth as auth_mod
    if not auth_mod._TOKEN:
        import secrets
        auth_mod._TOKEN = secrets.token_urlsafe(32)
    return {"Authorization": f"Bearer {auth_mod._TOKEN}"}


@pytest.fixture
def reset_settings():
    from backend.apps.settings.settings import load_settings, _save_settings
    original = load_settings().model_copy(deep=True)
    yield
    _save_settings(original)


@pytest.mark.asyncio
async def test_concurrent_writes_to_different_fields_both_survive(reset_settings):
    from backend.apps.settings.settings import load_settings, _save_settings

    base = load_settings()
    base.theme = "dark"
    base.default_mode = "agent"
    _save_settings(base)

    headers = _auth_headers()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=headers) as client:
        r1, r2 = await asyncio.gather(
            client.post("/api/settings-meta/write", json={"changes": {"theme": "light"}}),
            client.post("/api/settings-meta/write", json={"changes": {"default_mode": "chat"}}),
        )

    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["outcomes"]["theme"]["status"] == "applied"
    assert r2.json()["outcomes"]["default_mode"]["status"] == "applied"

    final = load_settings()
    # Both concurrent edits must persist; neither agent's "applied" result is a lie.
    assert final.theme == "light", "lost update: theme was clobbered by the concurrent write"
    assert final.default_mode == "chat", "lost update: default_mode was clobbered"
