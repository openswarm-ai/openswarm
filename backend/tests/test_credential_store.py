"""Moving a rotating credential out of 9Router's db.json without racing 9Router for the file.

The stakes: providers issue a NEW refresh token on every refresh and treat a replayed one as
theft, revoking the whole grant family. So exactly one holder may be able to refresh. Removing
`refreshToken` from a connection is what makes an instance structurally unable to rotate. If that
edit were lost to a concurrent router write, or if the router resurrected the token afterwards,
we would have two rotators and a dead account.

Run:
    cd backend && .venv/bin/python -m pytest tests/test_credential_store.py -v
"""

from __future__ import annotations

import json
import os
import stat

import pytest

import backend.apps.nine_router.credential_store as store
from backend.apps.nine_router import process

P_CONNECTION = {
    "id": "conn-1",
    "provider": "claude",
    "authType": "oauth",
    "accessToken": "access-value",
    "refreshToken": "refresh-value",
    "expiresAt": "2026-08-01T00:00:00.000Z",
    "isActive": True,
}


@pytest.fixture
def p_router(tmp_path, monkeypatch):
    """A stopped router with one oauth connection on disk. Restart is recorded, never real."""
    data_dir = tmp_path / "9router"
    data_dir.mkdir()
    db = {"providerConnections": [dict(P_CONNECTION), {"id": "conn-2", "authType": "apikey"}]}
    (data_dir / "db.json").write_text(json.dumps(db))
    monkeypatch.setattr(process, "nine_router_data_dir", lambda: str(data_dir))

    state = {"running": True, "restarts": 0}

    def p_stop() -> None:
        state["running"] = False

    async def p_ensure() -> None:
        state["restarts"] += 1
        state["running"] = True

    async def p_no_http() -> None:
        state["shutdown_calls"] += 1

    state["shutdown_calls"] = 0
    monkeypatch.setattr(process, "stop", p_stop)
    monkeypatch.setattr(process, "is_running", lambda: state["running"])
    monkeypatch.setattr(process, "ensure_running", p_ensure)
    # Hard-stubbed: without this the suite would POST /shutdown at whatever real router owns the port.
    monkeypatch.setattr(store, "request_shutdown", p_no_http)
    return state


def p_connection(data_dir_owner) -> dict:
    db = json.loads(open(store.db_path(), encoding="utf-8").read())
    return next(c for c in db["providerConnections"] if c["id"] == "conn-1")


def test_read_credential_returns_the_tokens(p_router):
    cred = store.read_credential("conn-1")
    assert cred is not None
    assert cred.provider == "claude"
    assert cred.access_token == "access-value"
    assert cred.refresh_token == "refresh-value"


def test_only_oauth_connections_are_listed(p_router):
    assert store.list_oauth_connection_ids() == ["conn-1"]


@pytest.mark.asyncio
async def test_dropping_the_refresh_token_removes_the_key(p_router):
    """Absent, not blank. 9Router's refresh dispatcher bails on a falsy refreshToken, so the key
    being gone is precisely what makes this instance unable to rotate."""
    ok = await store.apply_to_connection("conn-1", changes={}, drop=["refreshToken"])
    assert ok
    after = p_connection(p_router)
    assert "refreshToken" not in after
    assert after["accessToken"] == "access-value", "must not disturb the rest of the connection"


@pytest.mark.asyncio
async def test_router_is_stopped_then_restarted(p_router):
    await store.apply_to_connection("conn-1", changes={}, drop=["refreshToken"])
    assert p_router["shutdown_calls"] == 1, "an adopted router only goes down over HTTP"
    assert p_router["restarts"] == 1
    assert p_router["running"] is True


@pytest.mark.asyncio
async def test_refuses_to_edit_when_the_router_will_not_stop(p_router, monkeypatch):
    """The load-bearing guard. Editing under a live router risks losing the edit, or worse, the
    router rewriting the refresh token back after we have already handed it to the cloud."""
    monkeypatch.setattr(process, "is_running", lambda: True)
    monkeypatch.setattr(process, "stop", lambda: None)
    monkeypatch.setattr(store, "P_DOWN_WAIT_S", 0.2)

    ok = await store.apply_to_connection("conn-1", changes={}, drop=["refreshToken"])

    assert ok is False
    assert p_connection(p_router)["refreshToken"] == "refresh-value", "file must be untouched"


@pytest.mark.asyncio
async def test_restoring_a_refresh_token_round_trips(p_router):
    await store.apply_to_connection("conn-1", changes={}, drop=["refreshToken"])
    ok = await store.apply_to_connection("conn-1", changes={"refreshToken": "returned"}, drop=[])
    assert ok
    assert p_connection(p_router)["refreshToken"] == "returned"


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits; Windows ACLs do not surface through st_mode")
async def test_written_db_is_owner_only(p_router):
    await store.apply_to_connection("conn-1", changes={}, drop=["refreshToken"])
    mode = stat.S_IMODE(os.stat(store.db_path()).st_mode)
    assert mode & 0o077 == 0


@pytest.mark.asyncio
async def test_unknown_connection_changes_nothing(p_router):
    ok = await store.apply_to_connection("conn-missing", changes={"x": 1}, drop=[])
    assert ok is False
    assert p_connection(p_router)["refreshToken"] == "refresh-value"


@pytest.mark.asyncio
async def test_corrupt_db_is_not_overwritten(p_router):
    open(store.db_path(), "w", encoding="utf-8").write("{not json")
    ok = await store.apply_to_connection("conn-1", changes={}, drop=["refreshToken"])
    assert ok is False
    assert open(store.db_path(), encoding="utf-8").read() == "{not json"
