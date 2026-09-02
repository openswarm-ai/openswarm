"""An outage longer than the in-turn ladder must park the turn, not end it.

The 335s of CAPACITY_BACKOFFS is a blip's worth of patience. A closed lid, a switched network or a
provider's bad ten minutes outlasts it, and the user then comes back to a task that stopped for a
reason that was never theirs. These pin the widening retry, its bound, and the persistence that
makes quitting mid-wait survivable. Cross-platform by construction: file state and asyncio only,
no signals and no platform paths.
"""

import asyncio

import backend.apps.agents.core.ws_manager as ws_mod
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.run.handle_run_error import handle_run_error
from backend.apps.agents.manager.run.reconnect_resume import (
    RECONNECT_BACKOFFS,
    RECONNECT_MAX_DELAY_S,
    arm_reconnect_resume,
    clear_reconnect_wait,
)
from backend.apps.agents.manager.streaming.state import TurnState


def p_session() -> AgentSession:
    s = AgentSession(name="t", model="sonnet", dashboard_id="d")
    s.messages.append(Message(role="user", content="long task", branch_id=s.active_branch_id))
    return s


def p_drive(monkeypatch, exc, session=None, stderr=None, emitted=False):
    events = []

    async def fake_send(session_id, event, data):
        events.append((event, data))

    monkeypatch.setattr(ws_mod.ws_manager, "send_to_session", fake_send, raising=True)
    import backend.apps.service.client as service_client
    monkeypatch.setattr(service_client, "submit_diagnostic", lambda payload: None, raising=True)
    session = session or p_session()
    turn = TurnState()
    turn.current_turn_emitted = emitted
    asyncio.run(handle_run_error(exc, session, session.id, turn, stderr or []))
    return session, events


def test_an_outage_parks_the_turn_instead_of_ending_it(monkeypatch):
    session, events = p_drive(monkeypatch, ConnectionError("Connection reset by peer"))
    assert session.pending_continuation is True, "the work is queued to continue"
    assert session.pending_continuation_delay_s == RECONNECT_BACKOFFS[0]
    assert session.awaiting_reconnect is True
    assert session.needs_respawn is True, "the CLI died with the outage; a new process resumes the transcript"
    assert not [m for m in session.messages if m.role == "system"], "no card: nothing is over yet"
    assert "agent:reconnect_wait" in [e for e, _ in events]
    assert "agent:rate_limited" not in [e for e, _ in events]


def test_the_wait_widens_and_then_concedes(monkeypatch):
    session = p_session()
    for expected in RECONNECT_BACKOFFS:
        session.pending_continuation = False
        p_drive(monkeypatch, ConnectionError("network is unreachable"), session=session)
        assert session.pending_continuation_delay_s == expected

    # Budget spent: the honest pill fires rather than a fourth, longer silence.
    session.pending_continuation = False
    session, events = p_drive(monkeypatch, ConnectionError("network is unreachable"), session=session)
    assert session.pending_continuation is False
    assert "agent:rate_limited" in [e for e, _ in events]
    # Nothing reached the user and the retries are spent: "completed" put a green Done next to the
    # exhausted note (self-heal audit, 2026-09-01). A turn that got some text out still completes.
    assert session.status == "error"


def test_a_turn_that_already_spoke_ends_completed_when_the_budget_is_spent(monkeypatch):
    session = p_session()
    for _ in RECONNECT_BACKOFFS:
        session.pending_continuation = False
        p_drive(monkeypatch, ConnectionError("network is unreachable"), session=session)
    session.pending_continuation = False
    session, _events = p_drive(monkeypatch, ConnectionError("network is unreachable"), session=session, emitted=True)
    assert session.status == "completed"


def test_a_provider_reset_hint_outranks_our_schedule_but_is_capped():
    s = p_session()
    assert arm_reconnect_resume(s, retry_after_s=600) == 605
    s2 = p_session()
    assert arm_reconnect_resume(s2, retry_after_s=99999) == RECONNECT_MAX_DELAY_S


def test_a_shorter_hint_never_shrinks_the_wait():
    """Negative control: a 1s hint during a real outage must not become a 1s hot loop."""
    s = p_session()
    assert arm_reconnect_resume(s, retry_after_s=1) == RECONNECT_BACKOFFS[0]


def test_an_armed_continuation_is_never_stomped():
    """Negative control: something else already queued the next turn, so this must stand down."""
    s = p_session()
    s.pending_continuation = True
    s.pending_continuation_prompt = "someone else's continuation"
    assert arm_reconnect_resume(s) is None
    assert s.pending_continuation_prompt == "someone else's continuation"


def test_a_turn_that_got_through_returns_the_budget():
    s = p_session()
    arm_reconnect_resume(s)
    assert s.awaiting_reconnect is True
    clear_reconnect_wait(s)
    assert s.awaiting_reconnect is False


def test_quitting_mid_wait_leaves_an_owed_turn(monkeypatch, tmp_path):
    """The whole point of persisting the flag: the app going down DURING the wait must not be how
    a task quietly evaporates. Boot-restore has to see it, even though the status says completed."""
    from backend.apps.agents.agent_manager import AgentManager
    import backend.apps.agents.manager.session.SessionPersistence as sp

    parked = {
        "id": "sess-parked", "status": "completed", "awaiting_reconnect": True,
        "closed_at": None, "active_branch_id": "main",
        "messages": [{"role": "user", "content": "go", "branch_id": "main"}],
    }
    saved = {}
    monkeypatch.setattr(sp, "load_all_session_data", lambda: [("sess-parked", parked)], raising=True)
    monkeypatch.setattr(sp, "save_session", lambda sid, data: saved.update({sid: data}), raising=True)

    mgr = AgentManager()
    asyncio.run(mgr.reconcile_on_startup())
    assert "sess-parked" in mgr.crash_resume_queue, "a parked turn is an owed turn"
    assert saved["sess-parked"]["awaiting_reconnect"] is False, "the flag is consumed, not left to re-fire"


def test_the_breaker_stops_a_task_that_keeps_killing_the_app(monkeypatch):
    """If the work itself is what takes the process down, a second boot must hand it to the manual
    chip rather than launching it again."""
    import backend.apps.agents.manager.session.SessionPersistence as sp
    from backend.apps.agents.agent_manager import AgentManager

    parked = {
        "id": "sess-bad", "status": "completed", "awaiting_reconnect": True,
        "closed_at": None, "active_branch_id": "main", "crash_interrupt_count": 1,
        "messages": [{"role": "user", "content": "go", "branch_id": "main"}],
    }
    monkeypatch.setattr(sp, "load_all_session_data", lambda: [("sess-bad", parked)], raising=True)
    monkeypatch.setattr(sp, "save_session", lambda sid, data: None, raising=True)

    mgr = AgentManager()
    asyncio.run(mgr.reconcile_on_startup())
    assert mgr.crash_resume_queue == [], "second consecutive death: no third automatic run"


def test_the_wait_ends_the_moment_the_provider_answers(monkeypatch):
    """The backoff is a CEILING, not a sentence. A blind sleep would leave someone watching a
    spinner for fourteen more minutes after their wifi came back, which is worse than the button it
    replaced (Eric, 2026-08-20)."""
    import backend.apps.agents.manager.run.reconnect_resume as rr

    calls = {"probes": 0, "slept": 0.0}

    async def fake_sleep(secs, *a, **k):
        calls["slept"] += secs

    async def reachable_on_third_look(host):
        calls["probes"] += 1
        return calls["probes"] >= 3

    monkeypatch.setattr(rr.asyncio, "sleep", fake_sleep, raising=False)
    monkeypatch.setattr(rr, "provider_reachable", reachable_on_third_look, raising=True)

    s = p_session()
    asyncio.run(rr.wait_for_reconnect(s, 900))
    assert calls["probes"] == 3, "it stops looking as soon as the answer is yes"
    assert calls["slept"] == 3 * rr.RECONNECT_POLL_S, "it waited 9s of a 900s ceiling"


def test_an_outage_that_never_heals_still_honours_the_ceiling(monkeypatch):
    """Negative control: if nothing ever answers, the wait must END at the ceiling and try anyway,
    not poll forever."""
    import backend.apps.agents.manager.run.reconnect_resume as rr

    slept = {"total": 0.0}

    async def fake_sleep(secs, *a, **k):
        slept["total"] += secs

    async def never(host):
        return False

    monkeypatch.setattr(rr.asyncio, "sleep", fake_sleep, raising=False)
    monkeypatch.setattr(rr, "provider_reachable", never, raising=True)

    asyncio.run(rr.wait_for_reconnect(p_session(), 60))
    assert slept["total"] == 60, "the ceiling is honoured exactly, not overshot"


def test_the_probe_targets_the_provider_not_our_own_localhost_router():
    """A router lane points the CLI at localhost, which answers happily while the machine is
    offline: probing it would return the one wrong answer at the only moment it matters."""
    import backend.apps.agents.manager.run.reconnect_resume as rr

    s = p_session()
    for model, expected in (
        ("sonnet-5", "api.anthropic.com"),
        ("gpt-5.6-terra", "api.openai.com"),
        ("gemini-3-pro", "generativelanguage.googleapis.com"),
    ):
        s.model = model
        host = rr.provider_probe_host(s)
        assert host == expected, f"{model} -> {host}"
        assert "localhost" not in host and "127.0.0.1" not in host


def test_a_dead_socket_respawns_the_cli_but_a_429_does_not(monkeypatch):
    """Both arrive as 'transient', and they want different recoveries. A dead transport leaves the
    CLI holding a corpse, so the retry needs a fresh one. A 429 is a healthy pipe carrying a NO, and
    respawning for that spends a whole process to be told the same thing (caught by the existing
    test_rate_limit_does_not_respawn_the_cli when this shipped ungated)."""
    dead, _ = p_drive(monkeypatch, ConnectionError("Connection reset by peer"))
    assert dead.needs_respawn is True
    assert dead.awaiting_reconnect is True

    throttled, _ = p_drive(monkeypatch, Exception("429 rate_limit_error: overloaded"))
    assert throttled.needs_respawn is False, "a refusal is not a broken pipe"
    assert throttled.awaiting_reconnect is True, "but it is still worth waiting out"


def test_a_spent_budget_stops_pretending_the_turn_is_parked(monkeypatch):
    """Live catch, 2026-08-20 (rate-limited Gemini): after three outage rounds the budget is gone
    and the ask is over, but awaiting_reconnect stayed True. The terminal floor deliberately keeps
    quiet for parked turns, so the stale flag muzzled it and the run ended in total silence: the
    precise failure both features exist to prevent, created by one of them."""
    session = p_session()
    for _ in RECONNECT_BACKOFFS:
        session.pending_continuation = False
        p_drive(monkeypatch, ConnectionError("network is unreachable"), session=session)
    assert session.awaiting_reconnect is True, "still parked while the budget lasts"

    session.pending_continuation = False
    p_drive(monkeypatch, ConnectionError("network is unreachable"), session=session)
    assert session.awaiting_reconnect is False, "budget spent: the turn is over, not parked"

    # And with the flag honest, the floor can finally speak for this session.
    from backend.apps.agents.manager.run.turn_spoke import ensure_turn_spoke
    session.messages.append(Message(role="tool_call", content={"tool": "Read"},
                                    branch_id=session.active_branch_id))
    assert ensure_turn_spoke(session, "sid") is True
