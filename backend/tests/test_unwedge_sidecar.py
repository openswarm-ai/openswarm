"""The wedged-sidecar watchdog (ENG-303). Measured 2026-08-14: a SIGSTOP'd openswarm-core sidecar
left MemoryWrite outstanding 300s+ with the session 'running' forever; a SIGKILL'd one self-heals
(the CLI respawned it in ~18s and the next call succeeded). So the watchdog's whole job is turning
the first case into the second, and its whole risk is shooting a tool that legitimately blocks."""

import asyncio
import inspect

from backend.apps.agents.manager.streaming import unwedge_sidecar
from backend.apps.agents.manager.streaming.unwedge_sidecar import (
    WEDGE_SECONDS,
    arm_wedge_watchdog,
    is_quick_core_tool,
)


# --------------------------------------------------------------------- the capability guard


def test_every_legitimately_blocking_tool_is_exempt():
    # A timeout on any of these is a capability regression worse than the hang itself.
    for name in ("AskUI", "AskUserQuestion", "ShowUI", "CreateBrowserAgent", "AppAgent",
                 "SpawnAgent", "InvokeAgent", "RequestHumanIntervention", "MCPSearch", "MCPActivate"):
        assert not is_quick_core_tool(f"mcp__openswarm-core__{name}"), f"{name} must never be watchdogged"


def test_quick_core_tools_are_watched():
    for name in ("MemoryRead", "MemoryWrite", "SettingsRead", "SettingsWrite"):
        assert is_quick_core_tool(f"mcp__openswarm-core__{name}")


def test_non_core_tools_are_never_watched():
    # Bash can sleep for an hour on purpose; builtins and other MCP servers are out of scope.
    assert not is_quick_core_tool("Bash")
    assert not is_quick_core_tool("WebSearch")
    assert not is_quick_core_tool("mcp__github__create_issue")


def test_the_deadline_sits_between_twitchy_and_a_hang():
    # The quick class answers in milliseconds, so the floor is about not shooting a healthy-but-busy
    # sidecar, and the ceiling is about the user not reading recovery as a hang.
    assert 10 <= WEDGE_SECONDS <= 45, (
        f"{WEDGE_SECONDS}s is outside the band: under ~10s risks killing healthy work, "
        "over ~45s and the user has already given up"
    )


def test_a_retry_is_armed_so_the_lost_step_is_redone():
    from backend.apps.agents.manager.streaming.unwedge_sidecar import RETRY_PROMPT, arm_retry

    class S:
        pending_continuation = False
        pending_continuation_prompt = ""

    s = S()
    assert arm_retry(s) is True
    assert s.pending_continuation is True
    assert s.pending_continuation_prompt == RETRY_PROMPT


def test_a_retry_never_stacks_on_an_existing_continuation():
    from backend.apps.agents.manager.streaming.unwedge_sidecar import arm_retry

    class S:
        pending_continuation = True
        pending_continuation_prompt = "something else already queued"

    s = S()
    assert arm_retry(s) is False
    assert s.pending_continuation_prompt == "something else already queued"


def test_a_missing_session_is_survivable():
    from backend.apps.agents.manager.streaming.unwedge_sidecar import arm_retry
    assert arm_retry(None) is False


def test_the_watchdog_arms_the_retry_on_the_live_session():
    src = inspect.getsource(unwedge_sidecar.arm_wedge_watchdog)
    assert "arm_retry" in src, "killing the sidecar frees the turn but loses the in-flight call"


# --------------------------------------------------------------------- the kill choreography


def test_unwedge_thaws_before_terminating():
    # SIGTERM queues forever on a STOPPED process (ENG-196); CONT must come first, KILL last.
    src = inspect.getsource(unwedge_sidecar.unwedge)
    assert src.index("-CONT") < src.index("-TERM") < src.index("-KILL")


def test_attribution_is_by_env_never_argv():
    # Three kill-test rounds shot the wrong process by matching argv; the CLI's own argv embeds the
    # sidecar's command line inside --mcp-config.
    src = inspect.getsource(unwedge_sidecar.find_sidecar_pids)
    assert "OPENSWARM_PARENT_SESSION_ID" in src


# --------------------------------------------------------------------- the arm/disarm cycle


class FakeCtx:
    def __init__(self):
        self.tool_start_times = {}
        self.session_id = "sess-test"


def test_a_finished_call_disarms_by_having_been_popped():
    async def run():
        ctx = FakeCtx()
        ctx.tool_start_times["tu-1"] = 0.0
        fired = []
        original = unwedge_sidecar.unwedge
        unwedge_sidecar.unwedge = lambda *a: fired.append(a) or 0
        try:
            arm_wedge_watchdog(ctx, "tu-1", "mcp__openswarm-core__MemoryRead")
            ctx.tool_start_times.pop("tu-1")
            for t in [h for h in asyncio.get_running_loop()._scheduled]:
                pass
            await asyncio.sleep(0)
        finally:
            unwedge_sidecar.unwedge = original
        assert fired == [], "a completed call must never trigger the kill"
    asyncio.run(run())


def test_a_blocking_tool_arms_nothing_at_all():
    async def run():
        ctx = FakeCtx()
        loop = asyncio.get_running_loop()
        before = len(loop._scheduled)
        arm_wedge_watchdog(ctx, "tu-2", "mcp__openswarm-core__AskUI")
        assert len(loop._scheduled) == before, "an exempt tool must not even schedule a timer"
    asyncio.run(run())


# ------------------------------------------------- stale children must never read as settled


def p_fake_kid(parent: str, status: str, born_ts: float):
    from datetime import datetime

    class Kid:
        parent_session_id = parent
        mode = "browser-agent"

    k = Kid()
    k.status = status
    k.created_at = datetime.fromtimestamp(born_ts)
    return k


def test_stale_terminal_children_do_not_settle_a_new_delegation(monkeypatch):
    # The packaged-log failure (2026-08-16): a parent's second AppAgent call queued behind the
    # admission cap while its FIRST run's children sat terminal; the old check read that as
    # settled and shot a healthy sidecar. Children born before `since` must be invisible.
    import time as t
    from backend.apps.agents import agent_manager as am_mod
    now = t.time()
    kids = {"a": p_fake_kid("parent1", "completed", now - 600),
            "b": p_fake_kid("parent1", "stopped", now - 300)}
    monkeypatch.setattr(am_mod.agent_manager, "sessions", kids)
    assert unwedge_sidecar.delegation_children_settled("parent1", since=now - 10) is False
    # Negative control: with the scope disabled (since=0 sees every child), the old verdict comes
    # back, proving the filter is the thing doing the work.
    assert unwedge_sidecar.delegation_children_settled("parent1", since=0.0) is True


def test_fresh_terminal_child_settles_and_fresh_running_child_does_not(monkeypatch):
    import time as t
    from backend.apps.agents import agent_manager as am_mod
    now = t.time()
    call_started = now - 120
    monkeypatch.setattr(am_mod.agent_manager, "sessions",
                        {"a": p_fake_kid("parent1", "completed", now - 60)})
    assert unwedge_sidecar.delegation_children_settled("parent1", since=call_started) is True
    monkeypatch.setattr(am_mod.agent_manager, "sessions",
                        {"a": p_fake_kid("parent1", "running", now - 60)})
    assert unwedge_sidecar.delegation_children_settled("parent1", since=call_started) is False


def test_no_children_is_not_settled(monkeypatch):
    # A run queued behind the admission cap has no child yet; waiting is legitimate.
    from backend.apps.agents import agent_manager as am_mod
    monkeypatch.setattr(am_mod.agent_manager, "sessions", {})
    assert unwedge_sidecar.delegation_children_settled("parent1", since=0.0) is False


def test_mixed_stale_terminal_and_fresh_running_is_not_settled(monkeypatch):
    import time as t
    from backend.apps.agents import agent_manager as am_mod
    now = t.time()
    monkeypatch.setattr(am_mod.agent_manager, "sessions",
                        {"old": p_fake_kid("parent1", "completed", now - 900),
                         "new": p_fake_kid("parent1", "running", now - 30)})
    assert unwedge_sidecar.delegation_children_settled("parent1", since=now - 60) is False
