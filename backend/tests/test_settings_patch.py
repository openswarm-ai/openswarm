"""PATCH settings merges a diff onto fresh state, so a renderer save can't
clobber a field it didn't send. This is the structural close on the last
renderer-vs-agent race: the lost update is now unrepresentable, you can't
overwrite a field you never put in the body.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.main import app


def _auth_headers():
    import backend.auth as auth_mod
    if not auth_mod._TOKEN:
        import secrets
        auth_mod._TOKEN = secrets.token_urlsafe(32)
    return {"Authorization": f"Bearer {auth_mod._TOKEN}"}


@pytest.fixture
def client():
    return TestClient(app, headers=_auth_headers())


@pytest.fixture
def reset_settings():
    from backend.apps.settings.settings import load_settings, save_settings
    original = load_settings().model_copy(deep=True)
    yield
    save_settings(original)


def test_patch_changes_only_sent_fields(client, reset_settings):
    from backend.apps.settings.settings import load_settings, save_settings
    s = load_settings()
    s.theme = "dark"
    s.default_mode = "chat"  # as if something else had set this
    save_settings(s)

    r = client.patch("/api/settings", json={"theme": "light"})
    assert r.status_code == 200, r.text
    final = load_settings()
    assert final.theme == "light"           # the field we sent changed
    assert final.default_mode == "chat"     # the field we DIDN'T send is untouched


def test_patch_ignores_unknown_fields(client, reset_settings):
    r = client.patch("/api/settings", json={"theme": "light", "not_a_field": 123})
    assert r.status_code == 200
    # Unknown key is dropped, not stored; the real field still applied.
    from backend.apps.settings.settings import load_settings
    assert load_settings().theme == "light"
    assert "not_a_field" not in load_settings().model_dump()


@pytest.mark.asyncio
async def test_concurrent_renderer_patch_and_agent_write_both_survive(reset_settings):
    """The renderer PATCHes one field while an autonomous agent writes another,
    at the same time. Both must land: the renderer never sends the agent's field,
    so it can't clobber it, and both reads happen fresh under the shared lock."""
    from backend.apps.settings.settings import load_settings, save_settings
    base = load_settings()
    base.theme = "dark"
    base.default_mode = "agent"
    save_settings(base)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", headers=_auth_headers()) as client:
        r1, r2 = await asyncio.gather(
            client.patch("/api/settings", json={"theme": "light"}),
            client.post("/api/settings-meta/write", json={"changes": {"default_mode": "chat"}}),
        )
    assert r1.status_code == 200 and r2.status_code == 200

    final = load_settings()
    assert final.theme == "light", "renderer's change lost"
    assert final.default_mode == "chat", "agent's change clobbered by the renderer PATCH"
