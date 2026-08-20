"""Stop means stop: a queued injection must never resurrect an agent the user killed.

Field report 2026-08-20, verbatim: "even if we stop an agent by pausing it, or quitting the agent
outright, it'll resurrect itself and continue with the task, and pop up out of nowhere." The reporter
guessed the cause correctly (the hidden continuations), and the guess was right: stop_agent finalised
status and the live turn but left pending_continuation armed, and the dispatcher slept out its delay
(up to 900s once transient retries existed) before sending itself into a dead session.
"""

import asyncio


from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession


def p_armed_session() -> AgentSession:
    s = AgentSession(name="t", model="sonnet-5", dashboard_id="d")
    s.status = "running"
    s.pending_continuation = True
    s.pending_continuation_prompt = "carry on"
    s.pending_continuation_delay_s = 300
    agent_manager.sessions[s.id] = s
    return s


def test_stop_disarms_the_queued_injection():
    s = p_armed_session()
    asyncio.run(agent_manager.stop_agent(s.id))
    assert s.pending_continuation is False, "a stopped agent must not stay armed"
    assert s.pending_continuation_delay_s == 0
    assert s.awaiting_reconnect is False
    assert s.status == "stopped"


def test_the_dispatcher_stands_down_on_a_stopped_session():
    """Defence in depth: even if something arms the flag AFTER the stop, nothing may be sent."""
    s = p_armed_session()
    s.status = "stopped"
    sent = []
    real = agent_manager.send_message

    async def spy(sid, prompt, hidden=False, **kw):
        sent.append((sid, prompt))

    agent_manager.send_message = spy
    try:
        asyncio.run(agent_manager.dispatch_hidden_continuation(s.id, "carry on", 0))
    finally:
        agent_manager.send_message = real
    assert sent == [], "nothing may be injected into a session the user stopped"


def test_a_live_session_still_receives_its_continuation():
    """NEGATIVE CONTROL. The guard must not delete the self-heal it exists to protect; without this
    every retry we built today would silently stop working."""
    s = p_armed_session()
    s.status = "running"
    sent = []
    real = agent_manager.send_message

    async def spy(sid, prompt, hidden=False, **kw):
        sent.append((sid, prompt))

    agent_manager.send_message = spy
    try:
        asyncio.run(agent_manager.dispatch_hidden_continuation(s.id, "carry on", 0))
    finally:
        agent_manager.send_message = real
    assert sent == [(s.id, "carry on")], "a live session must still self-heal"


def test_a_vanished_session_is_not_resurrected_either():
    sent = []
    real = agent_manager.send_message

    async def spy(sid, prompt, hidden=False, **kw):
        sent.append((sid, prompt))

    agent_manager.send_message = spy
    try:
        asyncio.run(agent_manager.dispatch_hidden_continuation("no-such-session", "carry on", 0))
    finally:
        agent_manager.send_message = real
    assert sent == []
