"""A ceiling on harness-started turns, and proof it can only ever delay.

Measured 2026-08-24 across 79 installs: the median install starts 1 machine-initiated turn per
minute, 76 of 79 never pass 10, and three outliers sit at 16, 48 and 186. The 186 install produced
44 of the 45 policy blocks that window. These pin that the ceiling clips the pathological rate,
leaves every measured real install alone, and can neither deadlock nor drop work.
"""

import asyncio
import time

import pytest

from backend.tests.log_capture import LogCapture
from backend.apps.agents.manager import machine_turn_gate as gate


@pytest.fixture(autouse=True)
def p_clean():
    gate.reset_for_test()
    yield
    gate.reset_for_test()
    gate.SLICE_S = 2.0


def test_the_ceiling_leaves_every_measured_real_install_alone():
    # Fleet p90 is 6/min and the busiest legitimate install peaks at 9.
    gate.note_start_for_test(9)
    assert gate.wait_needed(time.monotonic()) == 0.0, "a real install must never be held"


def test_the_ceiling_clips_the_runaway():
    gate.note_start_for_test(186)
    assert gate.wait_needed(time.monotonic()) > 0


def test_the_window_rolls_so_a_hold_is_never_permanent():
    gate.note_start_for_test(gate.MACHINE_TURNS_PER_MINUTE)
    assert gate.wait_needed(time.monotonic()) > 0
    gate.roll_window_for_test(gate.WINDOW_S + 1)
    assert gate.wait_needed(time.monotonic()) == 0.0, \
        "a ceiling that never reopens is an outage, not a guard"


def test_it_delays_and_never_rejects():
    # Why this is a token bucket and not a semaphore: nothing is ever held, so nothing can deadlock,
    # and the caller always eventually proceeds with the work intact.
    async def main():
        for _ in range(gate.MACHINE_TURNS_PER_MINUTE):
            await gate.wait_for_machine_turn_slot("s1", "continuation")
        gate.roll_window_for_test(gate.WINDOW_S + 1)
        await asyncio.wait_for(gate.wait_for_machine_turn_slot("s1", "continuation"), timeout=2)
    asyncio.run(main())
    assert gate.admitted_count() == gate.MACHINE_TURNS_PER_MINUTE + 1


def test_a_hold_wakes_when_the_window_rolls_rather_than_sleeping_it_out():
    # One long sleep would sit out the full minute even after room appeared. Slices keep it honest.
    async def main():
        gate.note_start_for_test(gate.MACHINE_TURNS_PER_MINUTE)
        gate.SLICE_S = 0.05

        async def p_release():
            await asyncio.sleep(0.1)
            gate.roll_window_for_test(gate.WINDOW_S + 1)

        asyncio.create_task(p_release())
        t0 = time.monotonic()
        await asyncio.wait_for(gate.wait_for_machine_turn_slot("s1", "continuation"), timeout=5)
        return time.monotonic() - t0

    took = asyncio.run(main())
    assert took < 2.0, f"held {took:.1f}s after the window rolled; it slept the full delay"


def test_a_hold_names_the_session_and_says_a_human_is_never_held():
    async def main():
        gate.note_start_for_test(gate.MACHINE_TURNS_PER_MINUTE)
        gate.SLICE_S = 0.05

        async def p_release():
            await asyncio.sleep(0.1)
            gate.roll_window_for_test(gate.WINDOW_S + 1)

        asyncio.create_task(p_release())
        with LogCapture("backend.apps.agents.manager.machine_turn_gate") as cap:
            await asyncio.wait_for(gate.wait_for_machine_turn_slot("sess-abc", "continuation"), timeout=5)
        return cap.text

    text = asyncio.run(main())
    assert "sess-abc" in text and "human send is never held" in text


def test_the_gate_sits_at_the_one_chokepoint_both_callers_use():
    src = open("backend/apps/agents/agent_manager.py").read()
    assert src.count("dispatch_hidden_continuation(") >= 3, "both dispatch sites plus the def"
    i_gate = src.index("wait_for_machine_turn_slot(session_id")
    i_send = src.index("await self.send_message(session_id, prompt, hidden=True)")
    assert i_gate < i_send, "the ceiling has to be reached before the send, not after"


def test_a_human_send_never_reaches_the_gate():
    src = open("backend/apps/agents/agent_manager.py").read()
    head = src[:src.index("async def dispatch_hidden_continuation")]
    assert "wait_for_machine_turn_slot" not in head


def test_a_user_message_during_a_hold_is_never_talked_over():
    src = open("backend/apps/agents/agent_manager.py").read()
    i_gate = src.index("await wait_for_machine_turn_slot(session_id")
    after = src[i_gate:i_gate + 900]
    assert "superseded by a user message while held" in after, \
        "a minute-long hold needs the same no-stomp guard as the delay path"
    assert "p_settle_unstarted_continuation" in after, \
        "standing down must release the running promise, or the card spins forever"


def test_the_report_makes_a_dead_ceiling_visible():
    assert "0 starts admitted" in gate.gate_report()


def test_the_real_dispatcher_holds_the_runaway_and_loses_no_work(monkeypatch):
    """Drive the ACTUAL dispatch path: a gate can be perfect and wired to nothing."""
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.core.models import AgentSession

    session = AgentSession(name="gate", model="sonnet", dashboard_id="d")
    agent_manager.sessions[session.id] = session
    sent = []

    async def p_fake_send(sid, prompt, hidden=False, **kw):
        sent.append(prompt)

    monkeypatch.setattr(agent_manager, "send_message", p_fake_send, raising=True)
    gate.SLICE_S = 0.05

    async def main():
        for _ in range(gate.MACHINE_TURNS_PER_MINUTE):
            await agent_manager.dispatch_hidden_continuation(session.id, "go", 0)
        admitted_fast = len(sent)
        task = asyncio.create_task(agent_manager.dispatch_hidden_continuation(session.id, "held", 0))
        await asyncio.sleep(0.15)
        held = len(sent) == admitted_fast
        gate.roll_window_for_test(gate.WINDOW_S + 1)
        await asyncio.wait_for(task, timeout=5)
        return admitted_fast, held, sent[-1]

    admitted_fast, held, last = asyncio.run(main())
    agent_manager.sessions.pop(session.id, None)
    assert admitted_fast == gate.MACHINE_TURNS_PER_MINUTE, "normal traffic must pass straight through"
    assert held, "the 21st start in a minute must be held"
    assert last == "held", "a held continuation must still run; delaying is not dropping"


def test_a_user_message_during_a_real_hold_stands_the_continuation_down(monkeypatch):
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.core.models import AgentSession, Message

    session = AgentSession(name="gate2", model="sonnet", dashboard_id="d")
    agent_manager.sessions[session.id] = session
    sent = []

    async def p_fake_send(sid, prompt, hidden=False, **kw):
        sent.append(prompt)

    monkeypatch.setattr(agent_manager, "send_message", p_fake_send, raising=True)
    gate.SLICE_S = 0.05

    async def main():
        gate.note_start_for_test(gate.MACHINE_TURNS_PER_MINUTE)
        task = asyncio.create_task(agent_manager.dispatch_hidden_continuation(session.id, "stale", 0))
        await asyncio.sleep(0.1)
        session.messages.append(Message(role="user", content="actually do this instead"))
        gate.roll_window_for_test(gate.WINDOW_S + 1)
        await asyncio.wait_for(task, timeout=5)

    asyncio.run(main())
    status = agent_manager.sessions[session.id].status
    agent_manager.sessions.pop(session.id, None)
    assert sent == [], "the user already resumed the work; a held continuation must not talk over them"
    assert status != "running", "standing down must release the running promise, or the card spins forever"
