"""Preflight may bounce the router; it may never say a credential is dead. It has not dispatched.

ENG-414, production 1.7.9, hit twice in one session and the second one killed a live app build.
`LAST_BOUNCE` is a MODULE-LEVEL dict keyed by provider, and `BOUNCE_COOLDOWN_S` is 300, so the
branch that meant "this credential is permanently dead" actually meant "some OTHER chat restarted
the router in the last five minutes". The user was told "Waiting will not clear this one" and then
proved it wrong by typing "continue" a minute later and watching the run finish.
"""


import pytest

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.run import lane_preflight as p_pf

SRC = "backend/apps/agents/manager/run/lane_preflight.py"


def p_session() -> AgentSession:
    return AgentSession(id="s1", name="c", title="c", model="cc/claude-opus-5")


@pytest.fixture(autouse=True)
def p_clean():
    yield


@pytest.mark.asyncio
async def test_the_session_is_flagged_so_a_REAL_401_can_still_be_honest(monkeypatch):
    """Dispatching anyway must not lose the accuracy the old card had."""
    monkeypatch.setattr(p_pf, "dead_connection",
                        lambda provider: p_async({"testStatus": "unavailable", "errorCode": 401}))
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


async def p_async(value):
    return value


# ---------------------------------------------------- the drill seam itself (OSW_FAULT=dead_lane)

def test_the_injected_fault_is_the_shape_the_REAL_classifier_catches():
    """A drill that fires a fault the guard ignores would report a pass while proving nothing.
    Same rule the fault_injection module already states for its other faults."""
    conn = p_pf.injected_dead_conn("claude")
    assert p_pf.connection_is_dead(conn) is True
    assert conn["errorCode"] in (401, 403), "connection_is_dead requires auth evidence, not just unavailable"


def test_the_fault_is_declared_so_a_typo_cannot_arm_nothing():
    from backend.apps.agents.core.fault_injection import KNOWN_FAULTS
    assert "dead_lane" in KNOWN_FAULTS


@pytest.mark.asyncio
async def test_the_fault_is_inert_unless_armed(monkeypatch):
    monkeypatch.delenv("OSW_FAULT", raising=False)
    called = {"n": 0}

    async def p_real(provider):
        called["n"] += 1
        return None

    monkeypatch.setattr(p_pf, "dead_connection", p_real)
    await p_pf.preflight_lane("cc/claude-opus-5", p_session())
    assert called["n"] == 1, "unarmed, the real health read must still happen"
