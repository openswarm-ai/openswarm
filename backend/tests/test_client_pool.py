"""Invariant + seeded-simulation tests for the persistent-client pool (lever A of the TTFT work).
Proves the red-teamed safety properties hold by construction: fingerprint-gated reuse, respawn on
any boot-input change, pop-first disposal, never-raising teardown, and (seeded sim) that random op
sequences never reuse a stale client, never double-boot needlessly, and always recover a dead one."""

import asyncio
import random
from typing import Dict, List

import pytest

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.run.client_pool import (
    ClientHandle,
    acquire_client,
    boot_fingerprint,
    dispose_all_clients,
    dispose_client,
    dispose_client_soon,
    start_pool_sweeper,
    stop_pool_sweeper,
    trim_pool_to_cap,
)


class FakeClient:
    """Stands in for ClaudeSDKClient: counts connects/disconnects, can be killed, can raise on disconnect."""

    def __init__(self, registry: List["FakeClient"], raise_on_disconnect: bool = False):
        self.alive = True
        self.disconnected = False
        self.raise_on_disconnect = raise_on_disconnect
        registry.append(self)

    async def disconnect(self):
        self.disconnected = True
        self.alive = False
        if self.raise_on_disconnect:
            raise RuntimeError("teardown boom")


def make_session(branch: str = "main", compacted: str | None = None) -> AgentSession:
    s = AgentSession(name="t", model="haiku", mode="agent")
    s.active_branch_id = branch
    s.compacted_through_msg_id = compacted
    return s


BASE_KWARGS = {
    "model": "haiku",
    "cwd": "/tmp/ws",
    "system_prompt": {"type": "preset", "preset": "claude_code"},
    "allowed_tools": ["Read"],
    "disallowed_tools": ["mcp__claude_ai_*"],
    "mcp_servers": {"openswarm-mcp-meta": {"command": "python", "args": ["m.py"], "type": "stdio"}},
    "can_use_tool": lambda: None,
    "stderr": lambda line: None,
    "hooks": {"PreToolUse": []},
}


def test_fingerprint_stable_across_per_turn_keys():
    s = make_session()
    a = boot_fingerprint(dict(BASE_KWARGS), s)
    changed = dict(BASE_KWARGS)
    changed["can_use_tool"] = lambda: 1
    changed["stderr"] = lambda line: 1
    changed["hooks"] = {"PreToolUse": ["different"]}
    changed["resume"] = "sdk-session-xyz"
    changed["fork_session"] = True
    assert boot_fingerprint(changed, s) == a


@pytest.mark.parametrize("mutate", [
    lambda k, s: k.__setitem__("mcp_servers", {**k["mcp_servers"], "x": {"command": "node", "type": "stdio"}}),
    lambda k, s: k.__setitem__("system_prompt", {"type": "preset", "preset": "claude_code", "append": "sel"}),
    lambda k, s: k.__setitem__("model", "gpt-5-mini"),
    lambda k, s: k.__setitem__("cwd", "/tmp/other"),
    lambda k, s: k.__setitem__("allowed_tools", ["Read", "Bash"]),
    lambda k, s: setattr(s, "active_branch_id", "branch2"),
    lambda k, s: setattr(s, "compacted_through_msg_id", "msg42"),
])
def test_fingerprint_changes_on_boot_inputs(mutate):
    s = make_session()
    kwargs = dict(BASE_KWARGS)
    kwargs["mcp_servers"] = dict(BASE_KWARGS["mcp_servers"])
    before = boot_fingerprint(kwargs, s)
    mutate(kwargs, s)
    assert boot_fingerprint(kwargs, s) != before


def test_reuse_respawn_force_and_teardown():
    async def run():
        pool: Dict[str, ClientHandle] = {}
        made: List[FakeClient] = []

        async def connect():
            return FakeClient(made)

        h1 = await acquire_client(pool, "s1", "fpA", connect)
        h2 = await acquire_client(pool, "s1", "fpA", connect)
        assert h1 is h2 and len(made) == 1

        h3 = await acquire_client(pool, "s1", "fpB", connect)
        assert h3 is not h1 and len(made) == 2 and made[0].disconnected

        h4 = await acquire_client(pool, "s1", "fpB", connect, force_respawn=True)
        assert h4 is not h3 and len(made) == 3 and made[1].disconnected

        await dispose_client(pool, "s1")
        assert "s1" not in pool and made[2].disconnected
        await dispose_client(pool, "s1")  # idempotent

        async def connect_bad():
            return FakeClient(made, raise_on_disconnect=True)

        await acquire_client(pool, "s2", "fp", connect_bad)
        await dispose_client(pool, "s2")  # teardown error swallowed
        assert "s2" not in pool

        await acquire_client(pool, "s3", "fp", connect)
        dispose_client_soon(pool, "s3")
        assert "s3" not in pool  # pop is sync-first
        await asyncio.sleep(0.01)
        assert made[-1].disconnected

        await acquire_client(pool, "s4", "fp", connect)
        await acquire_client(pool, "s5", "fp", connect)
        await dispose_all_clients(pool)
        assert not pool and all(c.disconnected for c in made)

    asyncio.run(run())


def test_idle_eviction():
    async def run():
        import backend.apps.agents.manager.run.client_pool as cp
        pool: Dict[str, ClientHandle] = {}
        made: List[FakeClient] = []

        async def connect():
            return FakeClient(made)

        old_ttl = cp.IDLE_EVICT_SECONDS
        cp.IDLE_EVICT_SECONDS = 0.05
        try:
            h = await acquire_client(pool, "s1", "fp", connect)
            await acquire_client(pool, "s2", "fp", connect)
            await asyncio.sleep(0.1)
            # s1 is mid-turn (lock held): the sweep must skip it and evict only the idle s2.
            async with h.lock:
                await cp.evict_idle_clients(pool)
                assert "s1" in pool and "s2" not in pool and made[1].disconnected
            await asyncio.sleep(0.1)
            await cp.evict_idle_clients(pool)
            assert "s1" not in pool and made[0].disconnected
            # a fresh acquire after eviction reconnects transparently
            h2 = await acquire_client(pool, "s1", "fp", connect)
            assert h2.client.alive
        finally:
            cp.IDLE_EVICT_SECONDS = old_ttl

    asyncio.run(run())


def test_cap_lru_eviction():
    """Over MAX_LIVE_CLIENTS, acquire trims the least-recently-used IDLE sessions and keeps the newest."""
    async def run():
        import backend.apps.agents.manager.run.client_pool as cp
        pool: Dict[str, ClientHandle] = {}
        made: List[FakeClient] = []

        async def connect():
            return FakeClient(made)

        old_max, old_guard = cp.MAX_LIVE_CLIENTS, cp.LRU_GUARD_SECONDS
        cp.MAX_LIVE_CLIENTS, cp.LRU_GUARD_SECONDS = 3, 0.0
        try:
            for i in range(5):
                await acquire_client(pool, f"s{i}", "fp", connect)
                await asyncio.sleep(0.001)  # distinct last_used so LRU order is deterministic
            assert len(pool) == 3
            assert "s0" not in pool and "s1" not in pool  # two oldest reaped
            assert {"s2", "s3", "s4"} <= set(pool)
            assert made[0].disconnected and made[1].disconnected
            assert not made[3].disconnected and not made[4].disconnected
        finally:
            cp.MAX_LIVE_CLIENTS, cp.LRU_GUARD_SECONDS = old_max, old_guard

    asyncio.run(run())


def test_cap_soft_exceeds_when_busy():
    """A cap can't evict mid-turn clients: a new acquire over the cap exceeds it rather than kill a
    live turn, then trims back once they go idle."""
    async def run():
        import backend.apps.agents.manager.run.client_pool as cp
        pool: Dict[str, ClientHandle] = {}
        made: List[FakeClient] = []

        async def connect():
            return FakeClient(made)

        old_max, old_guard = cp.MAX_LIVE_CLIENTS, cp.LRU_GUARD_SECONDS
        cp.MAX_LIVE_CLIENTS, cp.LRU_GUARD_SECONDS = 2, 0.4
        try:
            h0 = await acquire_client(pool, "s0", "fp", connect)
            h1 = await acquire_client(pool, "s1", "fp", connect)
            async with h0.lock, h1.lock:
                await acquire_client(pool, "s2", "fp", connect)
                # s0/s1 locked, s2 just-acquired (guard-protected): nothing is eligible, so the pool exceeds the cap.
                assert len(pool) == 3
                assert not made[0].disconnected and not made[1].disconnected
            await asyncio.sleep(0.5)  # past the guard: the now-idle sessions become eligible
            await trim_pool_to_cap(pool)
            assert len(pool) == 2 and made[0].disconnected  # oldest idle reaped back to cap
        finally:
            cp.MAX_LIVE_CLIENTS, cp.LRU_GUARD_SECONDS = old_max, old_guard

    asyncio.run(run())


def test_pool_sweeper_reclaims_over_cap():
    """The background sweeper trims an over-cap pool on its timer, with no new turn to trigger it."""
    async def run():
        import backend.apps.agents.manager.run.client_pool as cp
        pool: Dict[str, ClientHandle] = {}
        made: List[FakeClient] = []

        async def connect():
            return FakeClient(made)

        old_max, old_guard, old_int = cp.MAX_LIVE_CLIENTS, cp.LRU_GUARD_SECONDS, cp.SWEEP_INTERVAL_SECONDS
        cp.MAX_LIVE_CLIENTS, cp.LRU_GUARD_SECONDS, cp.SWEEP_INTERVAL_SECONDS = 10, 0.0, 0.02
        try:
            for i in range(5):
                await acquire_client(pool, f"s{i}", "fp", connect)
                await asyncio.sleep(0.001)
            assert len(pool) == 5  # under the temporary high cap
            cp.MAX_LIVE_CLIENTS = 3
            task = start_pool_sweeper(pool)
            await asyncio.sleep(0.1)  # several sweep cycles
            await stop_pool_sweeper(task)
            assert len(pool) == 3
            assert "s0" not in pool and "s1" not in pool
            await stop_pool_sweeper(None)  # None is a no-op, must not raise
        finally:
            cp.MAX_LIVE_CLIENTS, cp.LRU_GUARD_SECONDS, cp.SWEEP_INTERVAL_SECONDS = old_max, old_guard, old_int

    asyncio.run(run())


def test_seeded_simulation_invariants():
    """Random op sequences: reuse only on identical fingerprint, dead clients always replaced, pool
    never re-serves a disposed client, and boots never exceed the one-shot baseline (one per turn)."""
    async def run():
        rng = random.Random(1337)
        pool: Dict[str, ClientHandle] = {}
        made: List[FakeClient] = []
        boots = 0
        turns = 0
        fp = "fp0"
        force = False

        async def connect():
            nonlocal boots
            boots += 1
            return FakeClient(made)

        for _ in range(300):
            op = rng.choice(["follow_up", "activate", "branch_or_fresh", "kill", "close"])
            if op == "follow_up":
                turns += 1
                h = await acquire_client(pool, "sim", fp, connect, force_respawn=force)
                force = False
                assert h.fingerprint == fp and not h.client.disconnected
                if not h.client.alive:  # dead client detected by the turn -> dispose + one respawn
                    await dispose_client(pool, "sim")
                    h = await acquire_client(pool, "sim", fp, connect)
                    assert h.client.alive
                async with h.lock:
                    assert h.lock.locked()  # single consumer while a turn drains
                    h.turns_served += 1
            elif op == "activate":
                fp = f"fp{rng.randint(0, 10**9)}"  # mcp_servers grew -> fingerprint changed
            elif op == "branch_or_fresh":
                force = True  # needs_fresh/fork read pre-build forces respawn
            elif op == "kill" and "sim" in pool:
                pool["sim"].client.alive = False
            elif op == "close":
                await dispose_client(pool, "sim")

        assert boots <= turns, f"persistent booted {boots}x for {turns} turns; one-shot baseline is {turns}"
        live = [c for c in made if not c.disconnected]
        assert len(live) <= 1, "at most the pooled client may be alive; everything else must be torn down"
        if "sim" in pool:
            assert not pool["sim"].client.disconnected

    asyncio.run(run())
