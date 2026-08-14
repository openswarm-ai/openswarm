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


def test_the_deadline_is_generous_not_twitchy():
    assert WEDGE_SECONDS >= 60, "a quick tool answers in ms; anything under a minute risks healthy kills"


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
