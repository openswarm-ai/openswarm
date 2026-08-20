"""Never spend a turn on a lane the router has already given up on.

Measured cost of not doing this (live drill, 2026-08-20, real codex lane): a credential dead for 89
hours produced a "just rotated, every couple minutes, no action needed" card, a 75s wait, a doomed
retry and five identical follow-up cards, for zero files read. The router had published
testStatus="unavailable" and errorCode=401 the whole time.
"""

import asyncio

import pytest

import backend.apps.agents.manager.run.lane_preflight as lp


@pytest.fixture(autouse=True)
def p_clear_cooldown():
    lp.LAST_BOUNCE.clear()
    yield
    lp.LAST_BOUNCE.clear()


def p_providers(monkeypatch, conns, bounce_result=None):
    """Stub the router's provider list; bounce_result, when given, is what the list becomes after a bounce."""
    state = {"conns": conns, "bounced": 0}

    async def fake_get_providers():
        return state["conns"]

    async def fake_bounce(provider):
        state["bounced"] += 1
        if bounce_result is not None:
            state["conns"] = bounce_result
        return True

    import backend.apps.nine_router as nr
    import backend.apps.nine_router.bounce_after_connect as ba
    monkeypatch.setattr(nr, "get_providers", fake_get_providers, raising=True)
    monkeypatch.setattr(ba, "bounce_router_after_connect", fake_bounce, raising=True)
    return state


P_DEAD = [{"provider": "codex", "testStatus": "unavailable", "errorCode": 401}]
P_LIVE = [{"provider": "codex", "testStatus": "active", "errorCode": None}]


def test_a_healthy_lane_costs_nothing_and_says_nothing(monkeypatch):
    st = p_providers(monkeypatch, P_LIVE)
    assert asyncio.run(lp.preflight_lane("cx/gpt-5.6")) is None
    assert st["bounced"] == 0, "a working lane must never trigger a router restart"


def test_the_first_dead_encounter_bounces_and_lets_the_turn_decide(monkeypatch):
    """The bounce is an attempt, not a verdict. It must not block the turn, and it must not claim
    a recovery it cannot see."""
    st = p_providers(monkeypatch, P_DEAD, bounce_result=P_DEAD)
    assert asyncio.run(lp.preflight_lane("cx/gpt-5.6")) is None, "dispatch is the real test"
    assert st["bounced"] == 1


def test_a_cleared_stamp_is_never_mistaken_for_a_working_credential(monkeypatch):
    """The bug this test exists for shipped for ten minutes on 2026-08-20. The first version
    re-read health after the bounce and returned "recovered" because a fresh router has no
    `unavailable` stamp yet. The credential was still dead and the turn 401'd seconds later.
    A restart clears the accusation, not the cause."""
    calls = {"health_reads": 0}
    real = lp.dead_connection

    async def counting(provider):
        calls["health_reads"] += 1
        return await real(provider)

    monkeypatch.setattr(lp, "dead_connection", counting, raising=True)
    p_providers(monkeypatch, P_DEAD, bounce_result=P_LIVE)
    asyncio.run(lp.preflight_lane("cx/gpt-5.6"))
    assert calls["health_reads"] == 1, (
        "health is read once, BEFORE the bounce; a post-bounce read is the false-recovery bug"
    )


def test_a_lane_still_dead_on_the_next_ask_gets_one_accurate_sentence(monkeypatch):
    """Second encounter inside the cooldown: we already spent a bounce and a turn, so stop
    pretending and say the true thing."""
    st = p_providers(monkeypatch, P_DEAD, bounce_result=P_DEAD)
    assert asyncio.run(lp.preflight_lane("cx/gpt-5.6")) is None
    msg = asyncio.run(lp.preflight_lane("cx/gpt-5.6"))
    assert msg and "ChatGPT" in msg and "Reconnect" in msg
    assert "rotated" not in msg.lower(), "never claim a rotation that did not happen"
    assert "no action needed" not in msg.lower(), "there IS action needed; saying otherwise is the bug"
    assert st["bounced"] == 1, "the cooldown holds; one restart, not one per ask"


def test_the_bounce_is_rate_limited(monkeypatch):
    """A bounce restarts a process every other session shares, so it is once per lane per window, never once per turn."""
    st = p_providers(monkeypatch, P_DEAD, bounce_result=P_DEAD)
    for _ in range(4):
        asyncio.run(lp.preflight_lane("cx/gpt-5.6"))
    assert st["bounced"] == 1, f"expected a single bounce, got {st['bounced']}"


def test_direct_api_lanes_are_left_alone(monkeypatch):
    """Negative control: a direct API key never dispatches through the router, so the router's health says nothing about it and must not ground it."""
    st = p_providers(monkeypatch, P_DEAD)
    assert asyncio.run(lp.preflight_lane("claude-sonnet-4-6")) is None
    assert st["bounced"] == 0


def test_unreadable_health_lets_the_turn_proceed(monkeypatch):
    """Negative control, and the important one: a preflight that cannot see must never guess 'dead'.
    Grounding a working lane on a failed health read would be a worse bug than the one this fixes."""
    async def boom():
        raise RuntimeError("router unreachable")

    import backend.apps.nine_router as nr
    monkeypatch.setattr(nr, "get_providers", boom, raising=True)
    assert asyncio.run(lp.preflight_lane("cx/gpt-5.6")) is None


def test_only_terminal_states_count_as_dead():
    assert lp.connection_is_dead({"testStatus": "unavailable"}) is True
    assert lp.connection_is_dead({"errorCode": 401}) is True
    assert lp.connection_is_dead({"errorCode": 403}) is True
    # A slow, rate-limited or merely idle connection is NOT dead; grounding those would be the bug.
    assert lp.connection_is_dead({"testStatus": "active", "errorCode": 429}) is False
    assert lp.connection_is_dead({"testStatus": "active", "errorCode": 502}) is False
    assert lp.connection_is_dead({}) is False
