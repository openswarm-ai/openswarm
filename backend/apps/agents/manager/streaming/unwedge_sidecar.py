"""A frozen MCP sidecar hangs its tool call FOREVER and the session sits 'running' for good
(measured 2026-08-14: SIGSTOP'd openswarm-core, MemoryWrite outstanding 300s+, no timeout on any
layer; ENG-303, Haik's 'core MCP drops and every capability dies'). A DEAD sidecar is fine, the
CLI respawns it (proven live, kill -9 -> new child in ~18s -> next call succeeds); only a WEDGED
one is fatal, because it never exits and nothing above it has a deadline.

So: when a quick-class core tool has been outstanding implausibly long, unfreeze-then-kill the
session's own sidecar so the hang becomes the already-self-healing death. Tools that legitimately
block (a human answering AskUI, a delegated browser run) are exempt by name, never by guess."""

import asyncio
import logging
import subprocess
import time
from typing import Set

from typeguard import typechecked

logger = logging.getLogger(__name__)

# The quick class answers in MILLISECONDS (memory, settings, schedule CRUD), so 25s is already a
# thousandfold margin: long enough that nothing healthy trips it, short enough that a user reads
# the recovery as a hiccup rather than a hang. Anything that legitimately blocks (a human, a
# delegated run) is exempt by name below, so this deadline never races real work.
WEDGE_SECONDS = 25.0

P_CORE_PREFIX = "mcp__openswarm-core__"

# Every core tool that may block on a human, a model, or a whole delegated run. A timeout on these
# would be a capability regression, which is worse than the bug.
P_BLOCKING_TOOLS: Set[str] = {
    "AskUI", "AskUserQuestion", "ShowUI",
    "CreateBrowserAgent", "BrowserAgent", "AppAgent",
    "SpawnAgent", "InvokeAgent", "RequestHumanIntervention",
    "MCPSearch", "MCPActivate",
}


@typechecked
def is_quick_core_tool(tool_name: str) -> bool:
    if not tool_name.startswith(P_CORE_PREFIX):
        return False
    return tool_name[len(P_CORE_PREFIX):] not in P_BLOCKING_TOOLS


@typechecked
def find_sidecar_pids(session_id: str) -> list:
    """The session's own combined sidecar(s), attributed by the OPENSWARM_PARENT_SESSION_ID in
    their env, never by argv (a CLI's argv embeds the sidecar's command line inside --mcp-config,
    which is how three kill-test rounds shot the wrong process)."""
    try:
        out = subprocess.run(
            ["ps", "ax", "-o", "pid=,command="], capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception:
        return []
    pids = []
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        pid, exe, rest = parts[0], parts[1], parts[2]
        if "combined_meta_mcp_server" not in rest or "python" not in exe.lower():
            continue
        try:
            env = subprocess.run(["ps", "eww", pid], capture_output=True, text=True, timeout=10).stdout
        except Exception:
            continue
        if f"OPENSWARM_PARENT_SESSION_ID={session_id}" in env:
            pids.append(int(pid))
    return pids


RETRY_PROMPT = (
    "Your last tool call never returned because its server had frozen; that server has been "
    "restarted and works now. Retry that one step, then carry on where you left off."
)


@typechecked
def arm_retry(session: object) -> bool:
    """Queue one hidden continuation so the agent redoes the lost step. Reuses the seam the
    silent-quit nudge already owns, and never stacks on a continuation that is already pending.
    Takes the live session the hook holds; there is no global registry to look one up in."""
    if session is None or getattr(session, "pending_continuation", False):
        return False
    try:
        session.pending_continuation = True          # type: ignore[attr-defined]
        session.pending_continuation_prompt = RETRY_PROMPT   # type: ignore[attr-defined]
        return True
    except Exception:
        return False


@typechecked
def unwedge(session_id: str, tool_name: str, outstanding_s: float) -> int:
    """CONT first: a STOPPED process queues TERM forever (the ghost-reaper lesson, ENG-196), so
    thaw it, then TERM, then KILL. Returns how many sidecars were put down."""
    pids = find_sidecar_pids(session_id)
    for pid in pids:
        for sig in ("-CONT", "-TERM"):
            subprocess.run(["kill", sig, str(pid)], capture_output=True)
        time.sleep(1.0)
        subprocess.run(["kill", "-KILL", str(pid)], capture_output=True)
    if pids:
        logger.warning(
            f"Agent {session_id}: core tool {tool_name} outstanding {outstanding_s:.0f}s; "
            f"unwedged sidecar pid(s) {pids} so the CLI can respawn it"
        )
        try:
            from backend.apps.service.client import submit_diagnostic
            submit_diagnostic({
                "kind": "mcp_sidecar_unwedged",
                "session_id": session_id,
                "tool": tool_name,
                "outstanding_s": round(outstanding_s, 1),
                "pids": pids,
            })
        except Exception:
            pass
    return len(pids)


@typechecked
def arm_wedge_watchdog(ctx: object, tool_use_id: str, tool_name: str) -> None:
    """One-shot, armed at PreToolUse for quick-class core tools only. If the post hook has not
    popped the id when the timer fires, the sidecar is wedged; put it down. A finished call
    disarms itself by having been popped, so the healthy path costs one dict lookup."""
    if not is_quick_core_tool(tool_name):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    started = time.time()

    def p_check() -> None:
        times = getattr(ctx, "tool_start_times", None)
        if not isinstance(times, dict) or tool_use_id not in times:
            return
        session_id = getattr(ctx, "session_id", "")
        if not session_id:
            return
        # ps + kill are blocking; keep them off the event loop. The retry is armed on the LIVE
        # session object the hook holds, so the agent redoes the step the frozen server swallowed.
        loop.run_in_executor(None, unwedge, session_id, tool_name, time.time() - started)
        arm_retry(getattr(ctx, "session", None))

    loop.call_later(WEDGE_SECONDS, p_check)
