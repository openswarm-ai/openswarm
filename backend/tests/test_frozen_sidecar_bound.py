"""A delegation call must be bounded by something, even when no child is ever born.

Reported by Haik Decie (ENG-402): during a Spotify task the MCP server "froze entirely and had to be
restarted by the harness before the call would return". The cause: `CreateBrowserAgent` is in
P_BLOCKING_TOOLS, which exempts it from the 25s wedge deadline AND therefore from the 300s hard
ceiling ENG-368 added so "a hung per-call thread cannot hang the session forever". Its replacement,
the delegation watchdog, keys on `delegation_children_settled`, which returns False when there are
no children -- correct for a run queued behind the admission cap, and fatal for a sidecar that died
before spawning one. Those two states were indistinguishable, so the second waited forever.

The discriminator is LIVENESS, not time.
"""

from backend.apps.agents.manager.streaming import delegation_watchdog as uw
from backend.apps.agents.manager.streaming import unwedge_sidecar as quick


def test_a_blocking_tool_is_exempt_from_the_quick_deadline():
    # Pinning the premise: if this ever stops being true the bug below cannot happen.
    assert quick.is_quick_core_tool("mcp__openswarm-core__CreateBrowserAgent") is False
    assert uw.is_delegation_core_tool("mcp__openswarm-core__CreateBrowserAgent") is True


def test_a_stale_heartbeat_reads_as_dead(monkeypatch):
    monkeypatch.setattr(uw, "heartbeat_age", lambda sid: uw.HEARTBEAT_FRESH_S + 1, raising=True)
    assert uw.sidecar_is_dead("s1") is True


def test_a_beating_sidecar_is_never_called_dead(monkeypatch):
    # The control that keeps this from killing a run legitimately queued behind the admission cap:
    # that run's sidecar is alive and heartbeating, so it must survive indefinitely.
    monkeypatch.setattr(uw, "heartbeat_age", lambda sid: 0.0, raising=True)
    assert uw.sidecar_is_dead("s1") is False
    monkeypatch.setattr(uw, "heartbeat_age", lambda sid: uw.HEARTBEAT_FRESH_S - 0.1, raising=True)
    assert uw.sidecar_is_dead("s1") is False


def test_the_watchdog_consults_liveness_not_only_settledness():
    src = open("backend/apps/agents/manager/streaming/delegation_watchdog.py").read()
    i_settled = src.index("settled = delegation_children_settled(session_id, started)")
    i_dead = src.index("sidecar_is_dead(session_id)")
    i_streak = src.index('settled_streak["n"] = settled_streak["n"] + 1 if settled else 0')
    assert i_settled < i_dead < i_streak, \
        "the liveness check has to run between the settled test and the streak, or it changes nothing"


def test_no_children_still_means_not_settled_on_its_own():
    # The admission-cap protection this must not break (ENG-327: scoping this wrong shot 39 healthy
    # sidecars in one afternoon). Liveness is an ADDITIONAL door, never a replacement.
    src = open("backend/apps/agents/manager/streaming/delegation_watchdog.py").read()
    assert "if not kids:\n        return False" in src


def test_a_live_child_keeps_the_call_alive_however_quiet_the_sidecar_looks(monkeypatch):
    """The control this fix must not break, scoped the way the watchdog scopes everything else."""
    import time
    from datetime import datetime, timezone
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents import agent_manager as am

    started = time.time()
    kid = AgentSession(id="kid-live", name="k", model="sonnet")
    kid.parent_session_id = "par-live"
    kid.mode = "browser-agent"
    kid.created_at = datetime.now(timezone.utc)
    am.agent_manager.sessions["kid-live"] = kid
    try:
        assert uw.no_child_ever_born("par-live", started) is False, \
            "a child born after the call started must block the liveness door entirely"
    finally:
        am.agent_manager.sessions.pop("kid-live", None)


def test_a_child_from_an_EARLIER_delegation_does_not_count(monkeypatch):
    # Same `since` scoping ENG-327 paid 39 dead sidecars to learn: a parent's second delegation must
    # not read its first run's children as this run's.
    import time
    from datetime import datetime, timezone, timedelta
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents import agent_manager as am

    old_kid = AgentSession(id="kid-old", name="k", model="sonnet")
    old_kid.parent_session_id = "par-old"
    old_kid.mode = "browser-agent"
    old_kid.created_at = datetime.now(timezone.utc) - timedelta(hours=1)
    am.agent_manager.sessions["kid-old"] = old_kid
    try:
        assert uw.no_child_ever_born("par-old", time.time()) is True
    finally:
        am.agent_manager.sessions.pop("kid-old", None)


def test_a_stopped_agent_is_never_resurrected_by_the_liveness_door(monkeypatch):
    """The regression this fix nearly shipped, caught by Eric asking the right question.

    A browser agent the user STOPS looks identical to a frozen sidecar: no child was born and the
    heartbeat is stale. The human-Stop guard used to live only inside `delegation_children_settled`,
    where it returns False meaning "do not recover" -- and the liveness door then overrode that
    False to True. That is ENG-369 ("stage 3 resent RETRY_PROMPT into the session the user had just
    stopped, every ~150s") coming back through a side door.
    """
    import asyncio
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents import agent_manager as am
    from backend.apps.agents.manager.streaming import delegation_watchdog as dw

    fired = {}
    monkeypatch.setattr(dw, "unwedge", lambda *a: fired.setdefault("unwedge", a), raising=True)
    monkeypatch.setattr(dw, "arm_retry", lambda s: fired.setdefault("retry", True), raising=True)
    monkeypatch.setattr(dw, "DELEGATION_CHECK_SECONDS", 0.05, raising=True)
    # The frozen-sidecar condition: dead heartbeat, and no child ever born.
    monkeypatch.setattr(dw, "heartbeat_age", lambda sid: dw.HEARTBEAT_FRESH_S + 99, raising=True)

    sess = AgentSession(id="par-stopped", name="p", model="sonnet")
    sess.ended_by_user = True
    am.agent_manager.sessions["par-stopped"] = sess

    class P_Ctx:
        def __init__(self):
            self.session = sess
            self.session_id = "par-stopped"
            self.tool_start_times = {"tu-1": 0.0}

    async def main():
        dw.arm_delegation_watchdog(P_Ctx(), "tu-1", "mcp__openswarm-core__CreateBrowserAgent")
        await asyncio.sleep(0.4)

    try:
        asyncio.run(main())
    finally:
        am.agent_manager.sessions.pop("par-stopped", None)

    assert "unwedge" not in fired, "a session the user stopped must never be unwedged back to life"
    assert "retry" not in fired, "and must never be handed a retry prompt"


def test_the_human_stop_check_runs_BEFORE_any_settled_predicate():
    # Placement is the fix. Inside a predicate it can be overridden; at the top it cannot.
    src = open("backend/apps/agents/manager/streaming/delegation_watchdog.py").read()
    i_stop = src.index("if p_ended_by_user(session_id):")
    i_settled = src.index("settled = delegation_children_settled(session_id, started)")
    i_door = src.index("sidecar_is_dead(session_id)", i_settled)
    assert i_stop < i_settled < i_door, \
        "a human's Stop has to short-circuit before anything can set settled"
