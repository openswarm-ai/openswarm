"""Every subscription lane (Claude sub, OpenSwarm Pro, GPT/codex, Gemini) self-heals a mid-run
token expiry before any card, and the codex retry waits out the 1-2 minute rotation window instead
of burning its one shot inside it (field screenshot 2026-08-19: a manual-reconnect card while the
turn was still alive). Only a missing credential, a config problem a retry cannot fix, goes
straight to the card."""

import asyncio

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.handle_run_error import handle_run_error
from backend.apps.agents.manager.streaming.auth_retry import try_auth_self_heal
from backend.apps.agents.manager.streaming.state import TurnState

# No reset hint here on purpose: a 401 that names its recovery window is claimed by the transient ladder instead (is_auth_error excludes it).
CODEX_401 = Exception("API Error: 401 [codex/gpt-5.6] authentication token is expired")
CLAUDE_401 = Exception("API Error: 401 authentication token is expired")
NO_CREDS = Exception("401 No credentials for provider: claude")


def p_session(model: str = "sonnet") -> AgentSession:
    s = AgentSession(name="t", model=model)
    s.messages.append(Message(role="user", content="do the thing"))
    return s


def test_delay_lands_on_the_session():
    s = p_session()
    assert try_auth_self_heal(s, delay_s=75) is True
    assert s.pending_continuation_delay_s == 75
    assert s.pending_continuation is True and s.needs_fresh_session is True


def test_budget_is_one_per_ask():
    s = p_session()
    assert try_auth_self_heal(s) is True
    assert try_auth_self_heal(s) is False


def test_codex_run_error_heals_with_rotation_wait():
    s = p_session(model="cx/gpt-5.6")
    asyncio.run(handle_run_error(CODEX_401, s, "sid-cx", TurnState(), []))
    assert s.pending_continuation is True
    assert s.pending_continuation_delay_s == 75
    cards = [m for m in s.messages if m.role == "system"]
    assert len(cards) == 1 and "no action needed" in str(cards[0].content)
    assert "Reconnect" not in str(cards[0].content), "rotation must never demand manual action"


def test_claude_run_error_heals_quickly_and_silently():
    s = p_session(model="sonnet")
    asyncio.run(handle_run_error(CLAUDE_401, s, "sid-cl", TurnState(), []))
    assert s.pending_continuation is True
    assert s.pending_continuation_delay_s == 5
    assert not any(m.role == "system" for m in s.messages), "short retries stay silent"


def test_missing_credential_goes_straight_to_the_card():
    s = p_session(model="sonnet-cc")
    asyncio.run(handle_run_error(NO_CREDS, s, "sid-nc", TurnState(), []))
    assert s.pending_continuation is False, "a retry fails identically; never heal a config problem"
    cards = [m for m in s.messages if m.role == "system"]
    assert len(cards) == 1 and "connect" in str(cards[0].content).lower()


def test_spent_budget_renders_exactly_one_card():
    s = p_session(model="cx/gpt-5.6")
    s.auth_retry_used = True
    asyncio.run(handle_run_error(CODEX_401, s, "sid-cx2", TurnState(), []))
    assert s.pending_continuation is False
    assert len([m for m in s.messages if m.role == "system"]) == 1


def test_dispatcher_stands_down_when_the_user_beats_the_delay(monkeypatch):
    from backend.apps.agents import agent_manager as p_am
    mgr = p_am.AgentManager.__new__(p_am.AgentManager)
    s = p_session()
    mgr.sessions = {"sid": s}
    sent = []

    async def p_fake_send(sid, prompt, **kw):
        sent.append(sid)
    mgr.send_message = p_fake_send

    async def p_fast_sleep(_):
        s.messages.append(Message(role="user", content="user got here first"))
    monkeypatch.setattr(p_am.asyncio, "sleep", p_fast_sleep)
    asyncio.run(mgr.dispatch_hidden_continuation("sid", "redo it", 75))
    assert sent == [], "a user message during the wait already resumes the work"


def test_dispatcher_sends_after_a_quiet_wait(monkeypatch):
    from backend.apps.agents import agent_manager as p_am
    mgr = p_am.AgentManager.__new__(p_am.AgentManager)
    s = p_session()
    mgr.sessions = {"sid": s}
    sent = []

    async def p_fake_send(sid, prompt, **kw):
        sent.append((sid, kw.get("hidden")))
    mgr.send_message = p_fake_send

    async def p_fast_sleep(_):
        return None
    monkeypatch.setattr(p_am.asyncio, "sleep", p_fast_sleep)
    asyncio.run(mgr.dispatch_hidden_continuation("sid", "redo it", 75))
    assert sent == [("sid", True)]
