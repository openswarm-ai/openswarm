"""One banner line per provider: two active db.json rows for one provider (stale + fresh connect)
used to probe twice and render "Your ChatGPT and ChatGPT logins have expired"."""

import asyncio

import pytest

from backend.apps.nine_router import subscription_health as sh
from backend.tests.test_subscription_health import FakeResponse


@pytest.mark.asyncio
async def test_duplicate_provider_rows_probe_and_report_once(monkeypatch):
    sh.invalidate_health_cache()
    monkeypatch.setattr(sh, "is_running", lambda: True)
    probed = []

    async def fake_pick(client, prefix):
        return prefix + "model"

    async def fake_probe(client, model):
        probed.append(model)
        return "dead"

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


# Verbatim live body (2026-09-04): the same "mid-refresh" text, answered by a codex login whose token had
# expired on 08-30; the app said nothing for six days because the reset-window excuse never expired.
LIVE_STALE_401 = '{"error":{"message":"[codex/gpt-5.4] [401]: Provided authentication token is expired. Please try signing in again. (reset after 26s)"}}'


class RefreshingClient:
    def __init__(self, answers, **kw) -> None:
        self.answers = answers

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def get(self, url: str, **kw):
        return FakeResponse(200, {"data": [{"id": "cx/gpt-5.4"}]})

    async def post(self, url: str, **kw):
        status, body = self.answers.pop(0)
        return FakeResponse(status, body)


def p_run(monkeypatch, answers, clock):
    monkeypatch.setattr(sh, "is_running", lambda: True)
    monkeypatch.setattr(sh.httpx, "AsyncClient", lambda **kw: RefreshingClient(answers, **kw))
    monkeypatch.setattr(sh.time, "monotonic", lambda: clock[0])
    return asyncio.run(sh.probe_subscription_health([{"provider": "codex", "isActive": True}]))


def test_a_mid_refresh_401_that_outlives_the_rotation_window_is_dead(monkeypatch):
    sh.invalidate_health_cache()
    clock = [1000.0]
    answers = [(401, LIVE_STALE_401), (401, LIVE_STALE_401)]
    assert p_run(monkeypatch, answers, clock) == [], "first sighting: a rotation is still possible"
    clock[0] += sh.P_CACHE_TTL_S + 1
    assert p_run(monkeypatch, answers, clock) == [{"provider": "codex", "label": "ChatGPT"}]
    assert answers == [], "both probes were spent"
    sh.invalidate_health_cache()


def test_a_401_that_heals_within_the_window_clears_the_sighting(monkeypatch):
    sh.invalidate_health_cache()
    clock = [1000.0]
    answers = [(401, LIVE_STALE_401), (200, {"content": []}), (401, LIVE_STALE_401)]
    assert p_run(monkeypatch, answers, clock) == []
    clock[0] += sh.P_CACHE_TTL_S + 1
    assert p_run(monkeypatch, answers, clock) == [], "healed: the sighting is dropped"
    clock[0] += sh.P_CACHE_TTL_S + 1
    assert p_run(monkeypatch, answers, clock) == [], "a fresh 401 starts a new window rather than inheriting the old one"
    sh.invalidate_health_cache()


def test_reconnect_forgets_the_sighting(monkeypatch):
    sh.invalidate_health_cache()
    clock = [1000.0]
    answers = [(401, LIVE_STALE_401), (401, LIVE_STALE_401)]
    assert p_run(monkeypatch, answers, clock) == []
    sh.invalidate_health_cache()
    clock[0] += sh.P_CACHE_TTL_S + 1
    assert p_run(monkeypatch, answers, clock) == [], "a deliberate reconnect restarts the window"
    sh.invalidate_health_cache()


@pytest.mark.asyncio
async def test_the_first_mid_refresh_sighting_gets_its_own_second_look(monkeypatch):
    # The dashboard asks once per boot; without a scheduled recheck the "wait and see" verdict is never revisited.
    sh.invalidate_health_cache()
    answers = [(401, LIVE_STALE_401), (401, LIVE_STALE_401)]
    monkeypatch.setattr(sh, "is_running", lambda: True)
    monkeypatch.setattr(sh.httpx, "AsyncClient", lambda **kw: RefreshingClient(answers, **kw))
    slept = []

    async def fake_sleep(s):
        slept.append(s)

    monkeypatch.setattr(sh.asyncio, "sleep", fake_sleep)
    sent = []
    from backend.apps.agents.core.ws_manager import ws_manager

    async def fake_broadcast(event, data):
        sent.append((event, data))

    monkeypatch.setattr(ws_manager, "broadcast_global", fake_broadcast)
    assert await sh.probe_subscription_health([{"provider": "codex", "isActive": True}]) == []
    task = sh.p_rechecks.get("codex")
    assert task is not None, "the first sighting must schedule a recheck"
    await task
    assert slept == [sh.P_ROTATION_WINDOW_S]
    assert sent == [("subscriptions:health", {"dead": [{"provider": "codex", "label": "ChatGPT"}]})]
    assert answers == [], "the recheck spent the second probe"
    assert sh.p_cached_result == [{"provider": "codex", "label": "ChatGPT"}], "a later boot-time fetch inside the TTL reads the same verdict"
    sh.invalidate_health_cache()


@pytest.mark.asyncio
async def test_a_recheck_that_finds_the_token_rotated_says_nothing(monkeypatch):
    sh.invalidate_health_cache()
    answers = [(401, LIVE_STALE_401), (200, {"content": []})]
    monkeypatch.setattr(sh, "is_running", lambda: True)
    monkeypatch.setattr(sh.httpx, "AsyncClient", lambda **kw: RefreshingClient(answers, **kw))

    async def fake_sleep(s):
        return None

    monkeypatch.setattr(sh.asyncio, "sleep", fake_sleep)
    sent = []
    from backend.apps.agents.core.ws_manager import ws_manager

    async def fake_broadcast(event, data):
        sent.append((event, data))

    monkeypatch.setattr(ws_manager, "broadcast_global", fake_broadcast)
    assert await sh.probe_subscription_health([{"provider": "codex", "isActive": True}]) == []
    await sh.p_rechecks["codex"]
    assert sent == [] and answers == []
    assert "codex" not in sh.p_refreshing_since, "a healthy recheck forgets the sighting"
    sh.invalidate_health_cache()
