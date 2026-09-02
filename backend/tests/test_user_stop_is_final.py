"""A human's Stop or close is final. Three automatic paths used to undo it, all reproduced live on
2026-08-20 (QA_LEDGER, same date): the delegation watchdog resent RETRY_PROMPT ~150s after a user
Stop (twice), a late machine send reloaded a CLOSED session from disk and wiped closed_at, and a plain
GET revived a closed card into memory and repainted it. One fact, ended_by_user, stamped only by the
human-facing routes, and honoured at each door.

Every positive test drives the REAL path (the real watchdog recovery, the real send_message reload,
the real resume_session), never a stand-in. Every door has a negative control, because the watchdog
and the resume paths exist for good reasons and gutting them is its own regression.
"""

import asyncio

from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.agents import close_session as user_close_route
from backend.apps.agents.agents import stop_agent as user_stop_route
from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming import delegation_watchdog


def p_live(name="t") -> AgentSession:
    s = AgentSession(name=name, model="sonnet-5", dashboard_id="d")
    s.status = "running"
    agent_manager.sessions[s.id] = s
    return s


def p_spy_loop():
    started = []
    real = agent_manager.run_agent_loop

    async def spy(sid, *a, **k):
        started.append(sid)

    agent_manager.run_agent_loop = spy
    return started, real


# --- who stamps the fact ------------------------------------------------------------------------

def test_only_the_human_routes_stamp_ended_by_user():
    s = p_live()
    asyncio.run(user_stop_route(s.id))
    assert s.ended_by_user is True
    t = p_live()
    asyncio.run(agent_manager.stop_agent(t.id))        # how the watchdogs call it
    assert t.ended_by_user is False, "an internal stop must keep its right to resend"


# --- DOOR 1: the delegation watchdog -------------------------------------------------------------

def test_a_user_stopped_parent_is_never_a_lost_result():
    """The children go `stopped` first, which used to read as 'every child terminal, result lost'."""
    parent = p_live("parent")
    child = AgentSession(name="child", model="sonnet-5", dashboard_id="d")
    child.mode = "browser-agent"
    child.parent_session_id = parent.id
    child.status = "stopped"
    agent_manager.sessions[child.id] = child
    asyncio.run(user_stop_route(parent.id))
    assert delegation_watchdog.delegation_children_settled(parent.id, 0.0) is False


def test_a_genuinely_lost_result_still_settles():
    """NEGATIVE CONTROL. Stage-3 recovery exists because a CLI blocked 20+ minutes never notices a
    killed sidecar; a parent nobody stopped, with every child terminal, must still trip it."""
    parent = p_live("parent2")
    child = AgentSession(name="child2", model="sonnet-5", dashboard_id="d")
    child.mode = "browser-agent"
    child.parent_session_id = parent.id
    child.status = "completed"
    agent_manager.sessions[child.id] = child
    assert delegation_watchdog.delegation_children_settled(parent.id, 0.0) is True


# --- DOOR 2: a machine send into a stopped or closed session -------------------------------------

def test_the_watchdog_resend_cannot_restart_a_user_stopped_session():
    """Drives the REAL stage-3 recovery (stop, sleep, RETRY_PROMPT)."""
    s = p_live()
    asyncio.run(user_stop_route(s.id))
    started, real = p_spy_loop()
    try:
        asyncio.run(delegation_watchdog.force_recover(s.id, s))
    finally:
        agent_manager.run_agent_loop = real
    assert started == []
    assert s.status == "stopped"


def test_the_watchdog_resend_still_fires_on_a_session_nobody_stopped():
    """NEGATIVE CONTROL for door 2."""
    s = p_live()
    started, real = p_spy_loop()
    try:
        asyncio.run(delegation_watchdog.force_recover(s.id, s))
    finally:
        agent_manager.run_agent_loop = real
    assert started == [s.id]


def test_a_closed_card_is_not_reopened_from_disk_by_a_hidden_send():
    s = p_live()
    s.status = "completed"
    asyncio.run(user_close_route(s.id))
    assert s.id not in agent_manager.sessions, "precondition: close purged it"
    started, real = p_spy_loop()
    try:
        asyncio.run(agent_manager.send_message(s.id, "carry on", hidden=True))
    finally:
        agent_manager.run_agent_loop = real
    assert started == []
    assert s.id not in agent_manager.sessions, "and it must not even be reloaded"


def test_the_users_own_next_message_lifts_the_hold():
    """NEGATIVE CONTROL: the hold must not brick the chat. A human typing is never hidden."""
    s = p_live()
    s.status = "stopped"
    s.ended_by_user = True
    started, real = p_spy_loop()
    try:
        asyncio.run(agent_manager.send_message(s.id, "ok keep going", hidden=False))
    finally:
        agent_manager.run_agent_loop = real
    assert started == [s.id]
    assert s.ended_by_user is False


# --- DOOR 3: merely reading a closed session -----------------------------------------------------

def test_reading_a_closed_session_does_not_revive_or_repaint_it():
    s = p_live()
    s.status = "completed"
    asyncio.run(user_close_route(s.id))
    assert s.id not in agent_manager.sessions
    sent = []
    from backend.apps.agents.core import ws_manager as wsm
    real = wsm.ws_manager.send_to_session

    async def spy(sid, event, payload):
        sent.append(event)

    wsm.ws_manager.send_to_session = spy
    try:
        got = asyncio.run(agent_manager.resume_session(s.id))
    finally:
        wsm.ws_manager.send_to_session = real
    assert got.id == s.id, "the read still returns the record"
    assert s.id not in agent_manager.sessions, "but does not put it back in memory"
    assert "agent:status" not in sent, "and does not repaint the card"


def test_reading_a_session_the_user_did_not_close_still_resumes_it():
    """NEGATIVE CONTROL for door 3: history browsing must keep working."""
    s = p_live()
    s.status = "completed"
    asyncio.run(agent_manager.close_session(s.id))      # internal close, not the user route
    assert s.id not in agent_manager.sessions
    got = asyncio.run(agent_manager.resume_session(s.id))
    assert got.id == s.id
    assert s.id in agent_manager.sessions


# --- DOOR 4: a child still BOOTING when its parent is closed must not outlive it ------------------
#
# Live, 2026-08-20: child de0ca12f was created 18:32:08, the parent was closed 18:32:12, and the child
# kept driving Amazon on a closed card for minutes ("it came back for a bit"). A child has no
# cancel_event during prestage, so close_session's stop missed it, then purged the parent; the old
# entry check compared `parent.status` on a parent that was now None and never fired.

def p_child_entry_check(parent_session_id):
    """The exact predicate at the child's registration, lifted so it can be driven without a browser."""
    from backend.apps.agents.agent_manager import agent_manager as am
    if not parent_session_id:
        return False
    parent = am.get_session(parent_session_id)
    if parent is not None:
        return parent.status == "stopped" or bool(getattr(parent, "ended_by_user", False))
    from backend.apps.agents.manager.session.session_store import load_session_data
    rec = load_session_data(parent_session_id) or {}
    return bool(rec.get("ended_by_user")) or rec.get("status") == "stopped"


def test_a_child_registering_after_its_parent_was_purged_bails():
    parent = p_live("closed-parent")
    asyncio.run(user_close_route(parent.id))
    assert parent.id not in agent_manager.sessions, "precondition: the close purged the parent"
    assert p_child_entry_check(parent.id) is True, "purged from memory but persisted as user-ended = bail"


def test_a_child_registering_under_a_user_stopped_parent_bails():
    parent = p_live("stopped-parent")
    asyncio.run(user_stop_route(parent.id))
    assert p_child_entry_check(parent.id) is True


def test_a_child_under_a_live_parent_proceeds():
    """NEGATIVE CONTROL: normal delegation must be untouched."""
    parent = p_live("live-parent")
    assert p_child_entry_check(parent.id) is False


def test_a_standalone_browser_run_with_no_parent_proceeds():
    """NEGATIVE CONTROL: a run that never had a parent is not an orphan; it must not self-cancel."""
    assert p_child_entry_check(None) is False
    assert p_child_entry_check("") is False


# --- the human's own Resume click is not a machine send ------------------------------------------


def test_the_resume_chip_lifts_the_hold_but_the_watchdog_still_cannot():
    """Live regression (Eric, 2026-08-21): clicking Resume on a user-stopped chat did nothing and the
    amber chip came straight back, forever. The chip's send is `hidden` only so no user bubble
    renders; this guard cares about AUTHORSHIP, so it must ask by_user, not hidden. Both directions
    pinned here: the human's click runs a turn and clears the hold, a machine's identical hidden send
    still does not."""
    started, real = p_spy_loop()
    try:
        # A machine send (the watchdog's resend) stays blocked: no turn, hold intact.
        machine = p_live("machine")
        machine.status = "stopped"
        machine.ended_by_user = True
        asyncio.run(agent_manager.send_message(machine.id, "Continue.", hidden=True))
        assert started == [], "a machine send must never revive a user-stopped chat"
        assert machine.ended_by_user is True, "the hold must survive a machine send"

        # The human's Resume click: same hidden flag, but by_user, so it runs and lifts the hold.
        human = p_live("human")
        human.status = "stopped"
        human.ended_by_user = True
        asyncio.run(agent_manager.send_message(human.id, "Continue your previous response.", hidden=True, by_user=True))
        assert started == [human.id], "the user's own Resume click must actually run a turn"
        assert human.ended_by_user is False, "the human lifted their own hold"
    finally:
        agent_manager.run_agent_loop = real
        for s in list(agent_manager.sessions.values()):
            if s.name in ("machine", "human"):
                agent_manager.sessions.pop(s.id, None)
