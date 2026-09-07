"""The refresh loop talks to the router the way the router actually answers (drilled live on 0.3.60, 2026-09-06)."""
import logging
import pathlib
import time

import pytest

from backend.apps.nine_router import oauth_refresh as orf

SRC = pathlib.Path("backend/apps/nine_router/oauth_refresh.py").read_text(encoding="utf-8")


def test_the_loop_posts_the_test_route():
    # A GET answers 405 on 0.3.60; the loop ran a day reading that as "unknown" and renewing nothing.
    assert 'client.post(f"{NINE_ROUTER_API}/providers/{connection_id}/test")' in SRC
    assert "client.get(" not in SRC


def test_the_loop_reads_the_router_live_view_not_the_file():
    # db.json said ChatGPT expired 08-30 while the router's live row said 09-17.
    assert "connections_due(await process.get_providers(), now, lent_connection_ids())" in SRC
    # The persisted file is consulted for ONE fact the live view redacts, whether a login is lent; never for expiry.
    body = SRC.split("def lent_connection_ids")[1].split("def connections_due")[0]
    assert SRC.count("read_persisted_connections") == 1 and "read_persisted_connections" in body


@pytest.mark.asyncio
async def test_an_answer_the_loop_cannot_read_is_logged_naming_the_login(monkeypatch):
    orf.p_last_unknown.clear()
    seen = []
    handler = logging.Handler()
    handler.emit = lambda rec: seen.append(rec.getMessage())
    orf.logger.addHandler(handler)
    try:
        monkeypatch.setattr(orf, "is_running", lambda: True)

        async def live():
            return [{"id": "c1", "provider": "claude", "authType": "oauth", "isActive": True, "expiresAt": "2026-01-01T00:00:00.000Z"}]

        async def test_connection(client, cid):
            return {"error": "HTTP 405"}

        monkeypatch.setattr(orf.process, "get_providers", live)
        monkeypatch.setattr(orf.process, "read_persisted_connections", lambda: [])
        monkeypatch.setattr(orf, "test_connection", test_connection)
        assert await orf.refresh_pass(now=time.time()) == {"claude": "unknown"}
        assert await orf.refresh_pass(now=time.time()) == {"claude": "unknown"}
    finally:
        orf.logger.removeHandler(handler)
    said = [m for m in seen if "NOT being renewed" in m and "claude" in m and "HTTP 405" in m]
    assert len(said) == 1, "logged once per answer shape, never silent"


def test_a_lent_login_is_named_from_the_persisted_file(monkeypatch):
    monkeypatch.setattr(orf.process, "read_persisted_connections", lambda: [{"id": "lent1", "provider": "claude"}, {"id": "own1", "provider": "codex", "refreshToken": "r"}])
    assert orf.lent_connection_ids() == {"lent1"}
