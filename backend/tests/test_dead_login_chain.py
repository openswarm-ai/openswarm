"""The dead-login chain after 2026-09-06: a turn's 401 advances the sighting, a second 401 reports at once, a
reconnect resumes the chats that died, and the refresh loop renews a login before it expires or reports one the
router cannot renew. Each guard is proven to FIRE, and the innocent case for each is beside it."""
from datetime import datetime, timezone

import pytest

from backend.apps.agents.core.models import AgentSession
from backend.apps.nine_router import oauth_refresh as orf
from backend.apps.nine_router import subscription_health as sh


@pytest.fixture(autouse=True)
def p_clean():
    sh.invalidate_health_cache()
    yield
    sh.invalidate_health_cache()


def test_a_turns_401_advances_the_sighting_and_never_resets_it(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(sh.time, "monotonic", lambda: clock[0])
    sh.note_auth_failure("codex")
    first = sh.p_refreshing_since["codex"]
    clock[0] += 200
    sh.note_auth_failure("codex")
    assert sh.p_refreshing_since["codex"] == first, "a later 401 must not restart the clock"
    assert sh.p_cached_result is None and sh.p_cached_at == 0.0, "only the cached answer is dropped, so the next ask re-probes"


def test_a_turns_401_keeps_a_scheduled_recheck_alive(monkeypatch):
    class FakeTask:
        cancelled = False
        def done(self): return False
        def cancel(self): self.cancelled = True
    t = FakeTask()
    sh.p_rechecks["codex"] = t  # type: ignore[assignment]
    sh.note_auth_failure("codex")
    assert t.cancelled is False, "invalidating the whole cache on a 401 used to cancel the recheck"
    sh.p_rechecks.clear()


def test_note_auth_failure_ignores_lanes_the_probe_does_not_cover():
    sh.note_auth_failure("openrouter")
    assert "openrouter" not in sh.p_refreshing_since


@pytest.mark.asyncio
async def test_a_second_401_reports_the_login_dead_this_second(monkeypatch):
    sent = []
    from backend.apps.agents.core.ws_manager import ws_manager
    async def fake_broadcast(event, data): sent.append((event, data))
    monkeypatch.setattr(ws_manager, "broadcast_global", fake_broadcast)
    assert await sh.report_dead_now("codex") is True
    assert sent == [("subscriptions:health", {"dead": [{"provider": "codex", "label": "ChatGPT"}]})]
    assert sh.p_cached_result == [{"provider": "codex", "label": "ChatGPT"}], "a boot-time ask inside the TTL reads the same verdict"
    assert await sh.report_dead_now("openrouter") is False and len(sent) == 1


def p_session(sid, provider, status="error", ended=False):
    s = AgentSession(id=sid, name=sid, prompt="x", status=status)
    s.auth_dead_provider = provider
    s.ended_by_user = ended
    s.lane_credential_dead = True
    s.auth_retry_used = True
    return s


@pytest.mark.asyncio
async def test_a_reconnect_resumes_only_the_chats_that_died_on_that_login():
    from backend.apps.agents.manager.session.SessionPersistence import SessionPersistence

    class Mgr(SessionPersistence):
        def __init__(self):
            self.sessions = {
                "dead-codex": p_session("dead-codex", "codex"),
                "dead-claude": p_session("dead-claude", "claude"),
                "stopped-by-human": p_session("stopped-by-human", "codex", ended=True),
                "still-running": p_session("still-running", "codex", status="running"),
            }
            self.sent = []
        async def send_message(self, sid, text, hidden=False):
            self.sent.append((sid, hidden))
    m = Mgr()
    assert await m.resume_auth_dead_sessions("codex") == 1
    assert m.sent == [("dead-codex", True)]
    s = m.sessions["dead-codex"]
    assert s.auth_dead_provider is None and s.lane_credential_dead is False and s.auth_retry_used is False, "the marker and the spent retry are cleared so the resumed chat can heal again next time"
    assert m.sessions["dead-claude"].auth_dead_provider == "claude", "another login's chats are untouched"
    assert m.sessions["stopped-by-human"].auth_dead_provider == "codex", "a human's Stop always wins"


def test_the_refresh_loop_asks_only_inside_the_margin():
    now = 1_000_000.0
    def conn(expires_in_s, **kw):
        base = {"id": "c1", "provider": "codex", "authType": "oauth", "isActive": True, "refreshToken": "r", "expiresAt": datetime.fromtimestamp(now + expires_in_s, timezone.utc).isoformat()}
        base.update(kw)
        return base
    assert orf.connections_due([conn(3 * 3600)], now) == []
    assert len(orf.connections_due([conn(10 * 60)], now)) == 1
    assert len(orf.connections_due([conn(-5 * 86400)], now)) == 1, "an already-expired login is asked about too"
    assert orf.connections_due([conn(10 * 60, refreshToken="")], now) == [], "a lent login (no refresh token) is the cloud's to rotate"
    assert orf.connections_due([conn(10 * 60, authType="api_key")], now) == []


def test_the_router_s_own_words_decide_the_verdict():
    assert orf.verdict_from_test({"valid": True, "refreshed": True}) == "refreshed"
    assert orf.verdict_from_test({"valid": True, "refreshed": False}) == "healthy"
    assert orf.verdict_from_test({"valid": False, "error": "Token expired and refresh failed", "refreshed": False}) == "dead"
    assert orf.verdict_from_test({"valid": False, "error": "Token invalid or revoked"}) == "dead"
    assert orf.verdict_from_test({"error": "HTTP 500"}) == "unknown", "a router hiccup is never a death"
    assert orf.verdict_from_test({"valid": False, "error": "rate limited"}) == "unknown"


@pytest.mark.asyncio
async def test_a_login_the_router_cannot_renew_is_reported_through_the_one_door(monkeypatch):
    now = 1_000_000.0
    conns = [{"id": "c1", "provider": "codex", "authType": "oauth", "isActive": True, "refreshToken": "r", "expiresAt": datetime.fromtimestamp(now - 60, timezone.utc).isoformat()}]
    monkeypatch.setattr(orf, "is_running", lambda: True)
    monkeypatch.setattr(orf.process, "read_persisted_connections", lambda: conns)
    async def fake_test(client, cid): return {"valid": False, "error": "Token expired and refresh failed", "refreshed": False}
    monkeypatch.setattr(orf, "test_connection", fake_test)
    reported = []
    async def fake_report(provider):
        reported.append(provider)
        return True
    monkeypatch.setattr(sh, "report_dead_now", fake_report)
    assert await orf.refresh_pass(now) == {"codex": "dead"}
    assert reported == ["codex"]


@pytest.mark.asyncio
async def test_a_renewed_login_says_nothing_and_a_down_router_asks_nobody(monkeypatch):
    now = 1_000_000.0
    conns = [{"id": "c1", "provider": "codex", "authType": "oauth", "isActive": True, "refreshToken": "r", "expiresAt": datetime.fromtimestamp(now + 60, timezone.utc).isoformat()}]
    monkeypatch.setattr(orf.process, "read_persisted_connections", lambda: conns)
    async def fake_test(client, cid): return {"valid": True, "refreshed": True}
    monkeypatch.setattr(orf, "test_connection", fake_test)
    reported = []
    async def fake_report(provider):
        reported.append(provider)
        return True
    monkeypatch.setattr(sh, "report_dead_now", fake_report)
    monkeypatch.setattr(orf, "is_running", lambda: True)
    assert await orf.refresh_pass(now) == {"codex": "refreshed"} and reported == []
    monkeypatch.setattr(orf, "is_running", lambda: False)
    assert await orf.refresh_pass(now) == {}


def test_the_refresh_loop_s_off_switch_is_declared_and_loud(monkeypatch):
    # caplog sees nothing from backend.* once the app is imported (PROJECT.md trap); a handler on the module's own logger does.
    import asyncio
    import logging
    monkeypatch.setenv("OSW_DISABLE_OAUTH_REFRESH", "1")
    assert orf.refresh_held_because() == "OSW_DISABLE_OAUTH_REFRESH=1"
    seen = []

    class Grab(logging.Handler):
        def emit(self, record):
            seen.append(record.getMessage())
    h = Grab(level=logging.WARNING)
    orf.logger.addHandler(h)
    try:
        asyncio.run(orf.oauth_refresh_loop())
    finally:
        orf.logger.removeHandler(h)
    assert any("NOT renewing subscription logins" in m for m in seen), "a guard that stands down must say so"


@pytest.mark.asyncio
async def test_the_preflight_writes_the_lane_the_error_handler_reads(monkeypatch):
    import backend.apps.agents.manager.run.lane_preflight as lp
    async def p_none(provider):
        return None
    monkeypatch.setattr(lp, "dead_connection", p_none)
    s = AgentSession(id="x", name="x", prompt="x")
    await lp.preflight_lane("cc/claude-sonnet-5", s)
    assert s.lane_provider == "claude"
    await lp.preflight_lane("claude-sonnet-4-6", s)
    assert s.lane_provider is None, "a direct API key has no router lane"


@pytest.mark.asyncio
async def test_a_definitive_auth_death_marks_the_chat_and_pushes_the_pill(monkeypatch):
    from backend.apps.agents.manager.run import handle_run_error as hre
    reported = []
    async def fake_report(provider):
        reported.append(provider)
        return True
    monkeypatch.setattr(sh, "report_dead_now", fake_report)
    s = AgentSession(id="x", name="x", prompt="x")
    s.lane_provider = "codex"
    await hre.p_mark_login_dead(s)
    assert s.auth_dead_provider == "codex" and reported == ["codex"]
    t = AgentSession(id="y", name="y", prompt="y")
    await hre.p_mark_login_dead(t)
    assert t.auth_dead_provider is None and reported == ["codex"], "a direct API key lane marks nothing"


def test_the_error_handler_marks_the_death_on_both_definitive_branches_and_before_the_card():
    import os
    src = open(os.path.join(os.path.dirname(__file__), "..", "apps", "agents", "manager", "run", "handle_run_error.py")).read()
    dead_branch = src.index('if getattr(session, "lane_credential_dead", False):')
    first_mark = src.index("await p_mark_login_dead(session)", dead_branch)
    dead_card = src.index("absorb_repeat_card(session, error_msg)", dead_branch)
    assert dead_branch < first_mark < dead_card, "the already-dead lane branch marks before it cards"
    second_mark = src.index("await p_mark_login_dead(session)", first_mark + 1)
    gate = src.index('if reason in ("codex_token_rotating", "anthropic_auth_invalid", "openswarm_pro_auth_expired"):')
    final_card = src.index("absorb_repeat_card(session, error_msg)", second_mark)
    assert gate < second_mark < final_card, "the definitive auth card marks only on the auth-shaped reasons, before the card"

