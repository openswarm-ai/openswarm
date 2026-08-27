"""Preflight may bounce the router; it may never say a credential is dead. It has not dispatched.

ENG-414, production 1.7.9, hit twice in one session and the second one killed a live app build.
`LAST_BOUNCE` is a MODULE-LEVEL dict keyed by provider, and `BOUNCE_COOLDOWN_S` is 300, so the
branch that meant "this credential is permanently dead" actually meant "some OTHER chat restarted
the router in the last five minutes". The user was told "Waiting will not clear this one" and then
proved it wrong by typing "continue" a minute later and watching the run finish.
"""

import time

import pytest

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.run import lane_preflight as p_pf

SRC = "backend/apps/agents/manager/run/lane_preflight.py"


def p_session() -> AgentSession:
    return AgentSession(id="s1", name="c", title="c", model="cc/claude-opus-5")


@pytest.fixture(autouse=True)
def p_clean():
    p_pf.LAST_BOUNCE.clear()
    yield
    p_pf.LAST_BOUNCE.clear()


@pytest.mark.asyncio
async def test_a_throttled_bounce_dispatches_instead_of_carding(monkeypatch):
    """The exact shape that killed the build: another chat bounced 10s ago, this lane reads dead."""
    monkeypatch.setattr(p_pf, "dead_connection",
                        lambda provider: p_async({"testStatus": "unavailable", "errorCode": 401}))
    p_pf.LAST_BOUNCE["claude"] = time.time() - 10      # another chat, well inside the 300s window
    s = p_session()
    assert await p_pf.preflight_lane("cc/claude-opus-5", s) is None, \
        "a throttled bounce says nothing about the credential; the turn must still be spent"


@pytest.mark.asyncio
async def test_the_session_is_flagged_so_a_REAL_401_can_still_be_honest(monkeypatch):
    """Dispatching anyway must not lose the accuracy the old card had."""
    monkeypatch.setattr(p_pf, "dead_connection",
                        lambda provider: p_async({"testStatus": "unavailable", "errorCode": 401}))
    p_pf.LAST_BOUNCE["claude"] = time.time() - 10
    s = p_session()
    await p_pf.preflight_lane("cc/claude-opus-5", s)
    assert s.lane_credential_dead is True, "handle_run_error keys its accurate card on this"


@pytest.mark.asyncio
async def test_a_healthy_lane_CLEARS_the_flag_instead_of_latching_it(monkeypatch):
    """It was set True and never reset anywhere, so one blip made every later auth error in that
    session claim a permanently dead credential."""
    s = p_session()
    s.lane_credential_dead = True
    monkeypatch.setattr(p_pf, "dead_connection", lambda provider: p_async(None))
    assert await p_pf.preflight_lane("cc/claude-opus-5", s) is None
    assert s.lane_credential_dead is False, "the flag is a live fact, not a latch"


@pytest.mark.asyncio
async def test_the_death_verdict_exists_in_exactly_one_place(monkeypatch):
    """Two code paths for one verdict is how they disagreed. Only the one downstream of a real
    failed dispatch may say it."""
    src = open(SRC).read()
    i = src.index("def preflight_lane")
    body = src[i:]
    assert "RECONNECT_COPY.get(" not in body, "preflight cannot know; it has not dispatched"
    handler = open("backend/apps/agents/manager/run/handle_run_error.py").read()
    assert "RECONNECT_COPY.get(" in handler, "the accurate card must survive downstream"
    assert 'getattr(session, "lane_credential_dead", False)' in handler, \
        "and it must still be gated on the router having given up BEFORE the turn"


@pytest.mark.asyncio
async def test_the_bounce_itself_is_still_throttled(monkeypatch):
    """A bounce restarts a process every session shares. Dispatching anyway must NOT turn into
    bouncing on every turn."""
    p_calls = []

    async def p_fake_bounce(provider):
        p_calls.append(provider)
        return True

    monkeypatch.setattr(p_pf, "dead_connection",
                        lambda provider: p_async({"testStatus": "unavailable", "errorCode": 401}))
    import backend.apps.nine_router.bounce_after_connect as p_b
    monkeypatch.setattr(p_b, "bounce_router_after_connect", p_fake_bounce)
    s = p_session()
    await p_pf.preflight_lane("cc/claude-opus-5", s)     # first: allowed to bounce
    await p_pf.preflight_lane("cc/claude-opus-5", s)     # second: throttled
    await p_pf.preflight_lane("cc/claude-opus-5", s)     # third: throttled
    assert len(p_calls) == 1, f"one bounce per {p_pf.BOUNCE_COOLDOWN_S}s window, got {len(p_calls)}"


@pytest.mark.asyncio
async def test_a_router_that_does_not_come_back_still_stops_the_turn(monkeypatch):
    """The one thing preflight CAN know without dispatching: it just restarted the router and the
    router is not listening. Dispatching into that is a guaranteed connection error the user would
    read as the model failing."""
    monkeypatch.setattr(p_pf, "dead_connection",
                        lambda provider: p_async({"testStatus": "unavailable", "errorCode": 401}))
    import backend.apps.nine_router.bounce_after_connect as p_b

    async def p_dead_bounce(provider):
        return False

    monkeypatch.setattr(p_b, "bounce_router_after_connect", p_dead_bounce)
    msg = await p_pf.preflight_lane("cc/claude-opus-5", p_session())
    assert msg and "restarting" in msg
    assert "Waiting will not clear" not in msg, "a restarting router is not a dead credential"


async def p_async(value):
    return value
