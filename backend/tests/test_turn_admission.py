"""Invariant tests for the root-turn admission gate (lever 3: cap concurrent agent turns so a burst
doesn't spawn every CLI at once). Proves the load-bearing properties: roots are bounded to the cap,
CHILD turns bypass it (else a parent awaiting a delegated child would deadlock the pool), the slot is
cancellation-safe (a stop while queued can't over-release), and the kill switch disables the gate."""

import asyncio
from typing import List, Optional, Tuple

from backend.apps.agents.core.models import AgentSession
import backend.apps.agents.agent_manager as am


def make_session(parent: Optional[str] = None) -> AgentSession:
    s = AgentSession(name="t", model="haiku", mode="agent")
    s.parent_session_id = parent
    return s


class Harness:
    """Fresh manager + a fake ws recorder + a scoped MAX_CONCURRENT_TURNS override."""

    def __init__(self, cap: int):
        self.mgr = am.AgentManager()
        self.events: List[Tuple[str, str]] = []
        self.cap = cap
        self.p_old_max = am.MAX_CONCURRENT_TURNS
        self.p_old_send = am.ws_manager.send_to_session

    async def p_fake_send(self, session_id: str, event: str, payload: dict) -> None:
        self.events.append((session_id, event))

    def __enter__(self) -> "Harness":
        am.MAX_CONCURRENT_TURNS = self.cap
        am.ws_manager.send_to_session = self.p_fake_send
        return self

    def __exit__(self, *exc) -> None:
        am.MAX_CONCURRENT_TURNS = self.p_old_max
        am.ws_manager.send_to_session = self.p_old_send


def test_root_turns_bounded_to_cap():
    async def run():
        with Harness(cap=3) as h:
            live = 0
            peak = 0

            async def one_root(i: int) -> None:
                nonlocal live, peak
                async with h.mgr.turn_admission_slot(make_session(), f"s{i}"):
                    live += 1
                    peak = max(peak, live)
                    await asyncio.sleep(0.02)
                    live -= 1

            await asyncio.gather(*[one_root(i) for i in range(9)])
            assert peak == 3  # never more than the cap ran concurrently
            queued = [e for e in h.events if e[1] == "agent:queued"]
            admitted = [e for e in h.events if e[1] == "agent:admitted"]
            assert len(queued) == 6  # 9 roots, cap 3 -> 6 waited
            assert len(admitted) == 6  # every queued turn was later admitted

    asyncio.run(run())


def test_children_bypass_gate():
    """The deadlock guard: with the only slot held by a root, a child must still run immediately."""
    async def run():
        with Harness(cap=1) as h:
            async with h.mgr.turn_admission_slot(make_session(), "root"):
                ran = False
                async with h.mgr.turn_admission_slot(make_session(parent="root"), "child"):
                    ran = True
                assert ran  # child bypassed the full gate
            assert not any(e[0] == "child" for e in h.events)  # bypass emits no queue events

    asyncio.run(run())


def test_kill_switch_disables_gate():
    async def run():
        with Harness(cap=0) as h:
            live = 0
            peak = 0

            async def one(i: int) -> None:
                nonlocal live, peak
                async with h.mgr.turn_admission_slot(make_session(), f"s{i}"):
                    live += 1
                    peak = max(peak, live)
                    await asyncio.sleep(0.01)
                    live -= 1

            await asyncio.gather(*[one(i) for i in range(5)])
            assert peak == 5  # cap<=0 -> no gating, all run at once
            assert not h.events  # nothing queued

    asyncio.run(run())


def test_cancel_while_queued_no_overrelease():
    async def run():
        with Harness(cap=1) as h:
            started = asyncio.Event()
            release = asyncio.Event()

            async def holder() -> None:
                async with h.mgr.turn_admission_slot(make_session(), "holder"):
                    started.set()
                    await release.wait()

            async def queued() -> None:
                async with h.mgr.turn_admission_slot(make_session(), "q"):
                    pass

            ht = asyncio.create_task(holder())
            await started.wait()  # holder owns the only slot
            qt = asyncio.create_task(queued())
            await asyncio.sleep(0.01)  # q is now blocked on acquire
            qt.cancel()
            try:
                await qt
            except asyncio.CancelledError:
                pass
            release.set()
            await ht
            sema = h.mgr.get_turn_admission()
            assert not sema.locked()  # holder's slot returned; queued-then-cancelled leaked nothing
            await sema.acquire()
            assert sema.locked()  # capacity is exactly 1: an over-release would leave it acquirable twice
            sema.release()

    asyncio.run(run())


def test_semaphore_rebuilds_per_loop():
    """Never bind to a dead loop: a second event loop gets a fresh semaphore, not the first's."""
    mgr = am.AgentManager()

    async def get_sema():
        return mgr.get_turn_admission()

    s1 = asyncio.run(get_sema())
    s2 = asyncio.run(get_sema())
    assert s1 is not s2


def make_background_session() -> AgentSession:
    s = AgentSession(name="Event check", model="haiku", mode="agent")
    s.background = True
    return s


def test_background_lane_never_queues_user_turns():
    """The lane split: checks saturating their own small pool must not block a root turn, and
    background turns never occupy main slots."""
    async def run():
        with Harness(cap=1) as h:
            old_bg = am.MAX_BACKGROUND_TURNS
            am.MAX_BACKGROUND_TURNS = 1
            try:
                bg_entered = asyncio.Event()
                bg_release = asyncio.Event()

                async def one_background() -> None:
                    async with h.mgr.turn_admission_slot(make_background_session(), "bg1"):
                        bg_entered.set()
                        await bg_release.wait()

                bg_task = asyncio.create_task(one_background())
                await bg_entered.wait()

                # Background pool is saturated (cap 1); a user root still admits instantly.
                user_ran = False
                async with h.mgr.turn_admission_slot(make_session(), "user1"):
                    user_ran = True
                assert user_ran
                assert not any(e == ("user1", "agent:queued") for e in h.events)

                # A second background turn queues behind the first, bounded by ITS lane.
                second_done = asyncio.Event()

                async def second_background() -> None:
                    async with h.mgr.turn_admission_slot(make_background_session(), "bg2"):
                        second_done.set()

                second_task = asyncio.create_task(second_background())
                await asyncio.sleep(0.05)
                assert not second_done.is_set()  # held by the background lane, not running
                bg_release.set()
                await asyncio.wait_for(second_task, timeout=2)
                await asyncio.wait_for(bg_task, timeout=2)
                # Invisible plumbing: background turns emit no queue frames at all.
                assert not any(e[0].startswith("bg") for e in h.events)
            finally:
                am.MAX_BACKGROUND_TURNS = old_bg

    asyncio.run(run())
