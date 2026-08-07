"""One banner line per provider: two active db.json rows for one provider (stale + fresh connect)
used to probe twice and render "Your ChatGPT and ChatGPT logins have expired"."""

import pytest

from backend.apps.nine_router import subscription_health as sh


@pytest.mark.asyncio
async def test_duplicate_provider_rows_probe_and_report_once(monkeypatch):
    sh.invalidate_health_cache()
    monkeypatch.setattr(sh, "is_running", lambda: True)
    probed = []

    async def fake_pick(client, prefix):
        return prefix + "model"

    async def fake_probe(client, model):
        probed.append(model)
        return True

    monkeypatch.setattr(sh, "p_pick_probe_model", fake_pick)
    monkeypatch.setattr(sh, "p_probe_one", fake_probe)
    conns = [
        {"provider": "codex", "isActive": True, "id": "stale"},
        {"provider": "codex", "isActive": True, "id": "fresh"},
        {"provider": "claude", "isActive": True, "id": "c1"},
    ]
    dead = await sh.probe_subscription_health(conns)
    assert probed == ["cx/model", "cc/model"], "one probe per provider, not per row"
    assert [d["label"] for d in dead] == ["ChatGPT", "Claude"], "labels never repeat"
    sh.invalidate_health_cache()


def test_self_healing_401_with_reset_window_is_not_dead():
    # Verbatim live body (2026-08-06): the codex lane 401s while its token is mid-refresh, then heals.
    body = '{"error":{"message":"[codex/gpt-5.2] [401]: Provided authentication token is expired. Please try signing in again. (reset after 1m 57s)"}}'
    assert not sh.classify_auth_dead(401, body)


def test_genuine_rotation_death_still_reports():
    assert sh.classify_auth_dead(401, "invalid_grant: refresh token rotated")
    assert sh.classify_auth_dead(403, "Unauthorized: expired credentials, please sign in")
