"""Boot-time subscription health probe: only a definitive auth-shaped 401/403 reads as dead
(transients stay silent so the reconnect pill can't cry wolf), probes cover only active
subscription lanes, and results are cached so a double boot-fetch can't double-spend probes."""

import asyncio
import json
from typing import Dict, List, Optional

import backend.apps.nine_router.subscription_health as sh


def test_classify_auth_dead_is_conservative():
    assert sh.classify_auth_dead(401, '{"error": "authentication token is expired"}')
    assert sh.classify_auth_dead(403, "Unauthorized access")
    assert sh.classify_auth_dead(401, "Invalid authentication credentials")
    assert not sh.classify_auth_dead(401, "weird opaque body")  # 401 without an auth marker stays silent
    assert not sh.classify_auth_dead(429, "rate limit expired")  # non-auth status never fires
    assert not sh.classify_auth_dead(500, "authentication service down")
    assert not sh.classify_auth_dead(200, "expired")


class FakeResponse:
    def __init__(self, status_code: int, payload: Dict):
        self.status_code = status_code
        self.text = json.dumps(payload)
        self.p_payload = payload

    def json(self) -> Dict:
        return self.p_payload


class FakeClient:
    """cc/ lane healthy, cx/ lane auth-dead, gemini/ lane rate-limited (must stay silent)."""

    def __init__(self, counter: List[int], **kwargs):
        self.counter = counter

    async def __aenter__(self) -> "FakeClient":
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def get(self, url: str, **kw) -> FakeResponse:
        return FakeResponse(200, {"data": [
            {"id": "cc/claude-haiku"}, {"id": "cx/gpt-5.4"}, {"id": "gemini/gemini-2.5-flash"},
        ]})

    async def post(self, url: str, **kw) -> FakeResponse:
        self.counter[0] += 1
        model = kw.get("json", {}).get("model", "")
        if model.startswith("cx/"):
            return FakeResponse(401, {"error": {"message": "authentication token is expired, try signing in again"}})
        if model.startswith("gemini/"):
            return FakeResponse(429, {"error": {"message": "rate limited"}})
        return FakeResponse(200, {"content": []})


CONNS = [
    {"provider": "claude", "isActive": True},
    {"provider": "codex", "isActive": True},
    {"provider": "gemini-cli", "isActive": True},
    {"provider": "openrouter", "isActive": True},  # not a sub lane; never probed
    {"provider": "codex", "isActive": False},  # inactive; never probed
]


def test_probe_reports_only_definitive_death_and_caches(monkeypatch):
    counter = [0]
    monkeypatch.setattr(sh, "is_running", lambda: True)
    monkeypatch.setattr(sh.httpx, "AsyncClient", lambda **kw: FakeClient(counter, **kw))
    monkeypatch.setattr(sh, "p_cached_result", None)
    monkeypatch.setattr(sh, "p_cached_at", 0.0)
    dead = asyncio.run(sh.probe_subscription_health(CONNS))
    assert dead == [{"provider": "codex", "label": "ChatGPT"}]
    assert counter[0] == 3  # claude + codex + gemini-cli probed; openrouter/inactive skipped
    # Second call within the TTL serves the cache; no new probe spend.
    dead2 = asyncio.run(sh.probe_subscription_health(CONNS))
    assert dead2 == dead
    assert counter[0] == 3


def test_probe_disabled_or_router_down(monkeypatch):
    monkeypatch.setattr(sh, "is_running", lambda: False)
    assert asyncio.run(sh.probe_subscription_health(CONNS)) == []
    monkeypatch.setattr(sh, "is_running", lambda: True)
    monkeypatch.setenv("OPENSWARM_BOOT_HEALTH", "0")
    assert asyncio.run(sh.probe_subscription_health(CONNS)) == []
