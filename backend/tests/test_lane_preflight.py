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


def test_a_lane_still_dead_inside_the_cooldown_DISPATCHES(monkeypatch):
    """CORRECTED 2026-08-27 (ENG-414). This used to assert the opposite, and the assumption it
    encoded is the bug: "second encounter inside the cooldown" was read as "we already spent a
    bounce and a turn on THIS session". `LAST_BOUNCE` is module-global, so in production it meant
    "some other chat bounced recently" and it hard-stopped a live build on a working credential.

    Preflight has not dispatched, so it cannot know. It dispatches and flags the session; the
    accurate sentence now comes from handle_run_error after a real 401. The cooldown still holds."""
    st = p_providers(monkeypatch, P_DEAD, bounce_result=P_DEAD)
    assert asyncio.run(lp.preflight_lane("cx/gpt-5.6")) is None
    assert asyncio.run(lp.preflight_lane("cx/gpt-5.6")) is None, \
        "a throttled bounce is not evidence about the credential"
    assert st["bounced"] == 1, "the cooldown holds; one restart, not one per ask"


def test_the_downstream_card_still_refuses_the_rotation_story():
    """What the old assertion above was really protecting: when the card DOES fire, it must not
    invent a rotation window or claim no action is needed. That copy moved, it did not soften."""
    for msg in lp.RECONNECT_COPY.values():
        assert "rotated" not in msg.lower(), "never claim a rotation that did not happen"
        assert "no action needed" not in msg.lower(), "there IS action needed; saying otherwise is the bug"
        assert "reconnect" in msg.lower(), msg


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
    # "unavailable" alone is NOT enough: the router stamps it for throttles and 5xx as well, so it
    # cannot distinguish a dead credential from a bad minute (corrected after a live false positive).
    assert lp.connection_is_dead({"testStatus": "unavailable"}) is False
    assert lp.connection_is_dead({"testStatus": "unavailable", "errorCode": 401}) is True
    assert lp.connection_is_dead({"testStatus": "unavailable", "errorCode": 403}) is True
    # A slow, rate-limited or merely idle connection is NOT dead; grounding those would be the bug.
    assert lp.connection_is_dead({"testStatus": "active", "errorCode": 429}) is False
    assert lp.connection_is_dead({"testStatus": "active", "errorCode": 502}) is False
    assert lp.connection_is_dead({}) is False


def test_never_dispatches_into_a_router_that_did_not_come_back(monkeypatch):
    """A bounce that fails to restart leaves nothing listening. Dispatching into that is a
    guaranteed connection error the user would read as the model failing, rather than as us
    restarting something underneath them."""
    async def fake_get_providers():
        return P_DEAD

    async def failed_bounce(provider):
        return False

    import backend.apps.nine_router as nr
    import backend.apps.nine_router.bounce_after_connect as ba
    monkeypatch.setattr(nr, "get_providers", fake_get_providers, raising=True)
    monkeypatch.setattr(ba, "bounce_router_after_connect", failed_bounce, raising=True)

    msg = asyncio.run(lp.preflight_lane("cx/gpt-5.6"))
    assert msg and "restarting" in msg.lower()
    assert "reconnect" not in msg.lower(), "this is our restart, not the user's credential"


def test_a_rate_limited_lane_is_not_a_dead_credential():
    """Live 2026-08-20: antigravity sat at testStatus=unavailable with errorCode=429 and a
    credential valid for another 30 minutes. Telling that user to reconnect is the same lie as
    "just rotated" for a dead token, aimed the other way."""
    assert lp.connection_is_dead({"testStatus": "unavailable", "errorCode": 429}) is False
    assert lp.connection_is_dead({"testStatus": "unavailable", "errorCode": 503}) is False
    assert lp.connection_is_dead({"testStatus": "unavailable", "errorCode": None}) is False


def test_only_auth_shaped_failures_send_the_user_to_settings():
    assert lp.connection_is_dead({"testStatus": "unavailable", "errorCode": 401}) is True
    assert lp.connection_is_dead({"testStatus": "unavailable", "errorCode": 403}) is True
    # The auth code has to be the router's CURRENT verdict: a row it calls active is serving traffic (2026-09-05, Eric's claude row).
    assert lp.connection_is_dead({"testStatus": "active", "errorCode": 403}) is False


# The router's own row for a WORKING claude login (2026-09-05, db.json): the 401 is stale, the status is current.
P_STALE_401_ACTIVE = [{"provider": "claude", "testStatus": "active", "errorCode": 401, "lastError": None, "lastErrorAt": None, "backoffLevel": 0}]


def test_an_active_row_with_a_stale_401_is_not_dead_and_bounces_nothing(monkeypatch):
    st = p_providers(monkeypatch, P_STALE_401_ACTIVE)
    assert lp.connection_is_dead(P_STALE_401_ACTIVE[0]) is False
    assert asyncio.run(lp.preflight_lane("cc/claude-sonnet-5")) is None
    assert st["bounced"] == 0, "a lane the router calls active must never trigger a router restart"


def test_a_throttle_is_still_not_death():
    # testStatus unavailable with a 429 is the Google case the docstring cites; the tightened rule keeps it.
    assert lp.connection_is_dead({"provider": "gemini-cli", "testStatus": "unavailable", "errorCode": 429}) is False
    assert lp.connection_is_dead({"provider": "codex", "testStatus": "unavailable", "errorCode": 401}) is True

