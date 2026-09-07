"""A dead-login verdict owns its second look: the pill closes and the chats resume when the lane answers again."""
import asyncio
import time
import pathlib

import pytest

from backend.apps.nine_router import subscription_health as sh


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    sh.invalidate_health_cache()
    sh.p_healed_hooks.clear()
    sent = []

    async def fake_broadcast(kind, payload):
        sent.append((kind, payload))

    from backend.apps.agents.core.ws_manager import ws_manager
    monkeypatch.setattr(ws_manager, "broadcast_global", fake_broadcast)
    yield sent
    sh.invalidate_health_cache()
    sh.p_healed_hooks.clear()


@pytest.mark.asyncio
async def test_a_dead_verdict_arms_its_own_second_look(clean):
    await sh.report_dead_now("codex")
    task = sh.p_reprobes.get("codex")
    assert task is not None and not task.done()
    task.cancel()


@pytest.mark.asyncio
async def test_a_healthy_reprobe_closes_the_pill_and_resumes_the_chats(clean, monkeypatch):
    sh.p_cached_result = [{"provider": "claude", "label": "Claude"}, {"provider": "codex", "label": "ChatGPT"}]
    sh.p_refreshing_since["claude"] = 1.0
    healed = []

    async def probe(client, model):
        return "healthy"

    async def hook(provider):
        healed.append(provider)

    monkeypatch.setattr(sh, "p_probe_one", probe)
    sh.p_healed_hooks.append(hook)
    await sh.p_reprobe("claude", "cc/claude-sonnet-5", 0)
    assert clean[-1] == ("subscriptions:health", {"dead": [{"provider": "codex", "label": "ChatGPT"}]})
    assert healed == ["claude"]
    assert "claude" not in sh.p_refreshing_since


@pytest.mark.asyncio
async def test_a_still_dead_reprobe_asks_again_with_backoff_up_to_the_cap(clean, monkeypatch):
    slept, armed = [], []

    async def nosleep(d):
        slept.append(d)

    async def probe(client, model):
        return "dead"

    monkeypatch.setattr(sh.asyncio, "sleep", nosleep)
    monkeypatch.setattr(sh, "p_probe_one", probe)
    monkeypatch.setattr(sh, "schedule_reprobe", lambda provider, model, delay=sh.P_REPROBE_S: armed.append(delay) or True)
    await sh.p_reprobe("codex", "cx/gpt-5.5", 240)
    await sh.p_reprobe("codex", "cx/gpt-5.5", 1000)
    await sh.p_reprobe("codex", "cx/gpt-5.5", 1800)
    assert slept == [240, 1000, 1800]
    assert armed == [480, 1800, 1800]
    assert clean == []


@pytest.mark.asyncio
async def test_a_reconnect_cancels_the_reprobe(clean):
    sh.schedule_reprobe("claude", None, 999)
    task = sh.p_reprobes["claude"]
    sh.invalidate_health_cache()
    await asyncio.sleep(0)
    assert task.cancelled()
    assert sh.p_reprobes == {}


def test_the_resume_hook_is_registered_at_boot():
    src = pathlib.Path("backend/apps/agents/agents.py").read_text(encoding="utf-8")
    assert "p_healed_hooks.append(agent_manager.resume_auth_dead_sessions)" in src


@pytest.mark.asyncio
async def test_a_flapping_login_resumes_a_chat_at_most_twice():
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents.manager.session.SessionPersistence import AUTH_RESUME_CAP, SessionPersistence

    class Mgr(SessionPersistence):
        def __init__(self):
            s = AgentSession(id="flap", name="flap", prompt="x", status="error")
            s.auth_dead_provider = "claude"
            s.auth_dead_at = time.time()
            self.sessions = {"flap": s}
            self.sent = 0

        async def send_message(self, sid, text, hidden=False):
            self.sent += 1

    m = Mgr()
    for _ in range(AUTH_RESUME_CAP + 2):
        await m.resume_auth_dead_sessions("claude")
        m.sessions["flap"].auth_dead_provider = "claude"
        m.sessions["flap"].auth_dead_at = time.time()
        m.sessions["flap"].status = "error"
    assert m.sent == AUTH_RESUME_CAP
    assert m.sessions["flap"].auth_dead_provider == "claude", "the marker stays so the card still says which login died"
