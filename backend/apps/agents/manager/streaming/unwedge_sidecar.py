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
import os
import subprocess
import threading
import time
from typing import Set

from typeguard import typechecked

logger = logging.getLogger(__name__)

# The quick class answers in MILLISECONDS (memory, settings, schedule CRUD), so 25s is already a
# thousandfold margin: long enough that nothing healthy trips it, short enough that a user reads
# the recovery as a hiccup rather than a hang. Anything that legitimately blocks (a human, a
# delegated run) is exempt by name below, so this deadline never races real work.
WEDGE_SECONDS = 25.0
# A sidecar whose heartbeat still beats is ALIVE with one slow tool, not wedged; give it this long
# before concluding the call is hung anyway (measured: 5 healthy-sidecar kills in one loaded evening
# were every one of Haik's "MCP disconnected" reports, ENG-353).
LATE_WEDGE_SECONDS = 120.0
HEARTBEAT_FRESH_S = 12.0

P_CORE_PREFIX = "mcp__openswarm-core__"

# Every core tool that may block on a human, a model, or a whole delegated run. A timeout on these
# would be a capability regression, which is worse than the bug.
P_BLOCKING_TOOLS: Set[str] = {
    "AskUI", "AskUserQuestion", "ShowUI",
    "CreateBrowserAgent", "BrowserAgent", "AppAgent",
    "SpawnAgent", "InvokeAgent", "RequestHumanIntervention",
    "MCPSearch", "MCPActivate",
    "RunToolScript",
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


@typechecked
def heartbeat_age(session_id: str) -> float:
    """Seconds since the session's sidecar last proved its process alive, or a huge number when no
    heartbeat exists (old sidecar builds have none: treat as wedged-on-timeout, the old behavior)."""
    import tempfile
    path = os.path.join(tempfile.gettempdir(), f"osw-mcp-hb-{session_id}")
    try:
        return max(0.0, time.time() - os.path.getmtime(path))
    except OSError:
        return 1e9


@typechecked
def wedge_verdict(outstanding_s: float, hb_age: float) -> str:
    """kill | extend | wait. Stale heartbeat = the PROCESS is wedged, kill at the first deadline.
    Fresh heartbeat = alive with a slow call: extend once, and only a call still outstanding at the
    late deadline dies (a hung per-call thread must not hang the session forever)."""
    if outstanding_s >= LATE_WEDGE_SECONDS:
        return "kill"
    if hb_age > HEARTBEAT_FRESH_S:
        return "kill"
    return "extend"


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
        outstanding = time.time() - started
        verdict = wedge_verdict(outstanding, heartbeat_age(session_id))
        if verdict == "extend":
            logger.info(
                f"Agent {session_id}: core tool {tool_name} outstanding {outstanding:.0f}s but the "
                f"sidecar heartbeat is fresh (alive, slow); re-checking at {LATE_WEDGE_SECONDS:.0f}s")
            loop.call_later(LATE_WEDGE_SECONDS - outstanding, p_check)
            return
        # ps + kill are blocking; keep them off the event loop. A daemon thread, not the loop's
        # default executor: executor workers are non-daemon and a per-test loop that closes without
        # shutdown leaks them parked forever (the suite's flaky hang at interpreter exit).
        threading.Thread(target=unwedge, args=(session_id, tool_name, outstanding), daemon=True, name="unwedge").start()
        arm_retry(getattr(ctx, "session", None))

    loop.call_later(WEDGE_SECONDS, p_check)


# Delegation tools legitimately run for minutes, so they are exempt from the 25s deadline above.
# The exemption assumed the child's result always comes home; measured 2026-08-15 on a packaged
# build, a CreateBrowserAgent child COMPLETED (backend returned its HTTP 200, sidecar went back to
# readline) while the parent hung on the outstanding tool call for 20+ minutes: the result died on
# the sidecar->CLI stdio hop and nothing above it has a deadline. When every child is terminal and
# stays terminal across two consecutive checks, the wait is provably pointless; recover the same
# way the quick class does.
P_DELEGATION_TOOLS: Set[str] = {"CreateBrowserAgent", "BrowserAgent", "BrowserAgents", "AppAgent"}
DELEGATION_CHECK_SECONDS = 75.0


@typechecked
def is_delegation_core_tool(tool_name: str) -> bool:
    return tool_name.startswith(P_CORE_PREFIX) and tool_name[len(P_CORE_PREFIX):] in P_DELEGATION_TOOLS


@typechecked
def delegation_children_settled(session_id: str, since: float) -> bool:
    """True when this session has delegated children born AFTER this tool call started and every one
    of them is terminal. No children yet is NOT settled: a run queued behind the admission cap can
    wait minutes legitimately. The `since` scope is load-bearing: a parent's SECOND delegation used
    to read its first run's terminal children as 'settled' while the new run was still queued, and
    the watchdog shot a healthy sidecar mid-run (39 kills + 40 force-ended turns in one afternoon
    of concurrent load, measured 2026-08-16 on the packaged build)."""
    from backend.apps.agents.agent_manager import agent_manager
    kids = []
    for s in agent_manager.sessions.values():
        if getattr(s, "parent_session_id", None) != session_id or getattr(s, "mode", "") != "browser-agent":
            continue
        born = getattr(s, "created_at", None)
        try:
            if born is None or born.timestamp() < since:
                continue
        except Exception:
            continue
        kids.append(s)
    if not kids:
        return False
    return all(getattr(s, "status", "") in ("completed", "error", "failed", "stopped") for s in kids)


@typechecked
def arm_delegation_watchdog(ctx: object, tool_use_id: str, tool_name: str) -> None:
    """Recurring, slow-cadence sibling of arm_wedge_watchdog for delegation tools. Fires the same
    unwedge+retry only after TWO consecutive checks (>=75s apart) see every child terminal while
    the tool call is still outstanding, so a child that is merely slow can never trip it."""
    if not is_delegation_core_tool(tool_name):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return

    started = time.time()
    settled_streak = {"n": 0}

    def p_check() -> None:
        times = getattr(ctx, "tool_start_times", None)
        if not isinstance(times, dict) or tool_use_id not in times:
            return
        session_id = getattr(ctx, "session_id", "")
        if not session_id:
            return
        try:
            settled = delegation_children_settled(session_id, started)
        except Exception:
            settled = False
        settled_streak["n"] = settled_streak["n"] + 1 if settled else 0
        if settled_streak["n"] == 2:
            logger.warning(
                "delegation result lost: %s outstanding %.0fs on session %s with every child terminal; recovering",
                tool_name, time.time() - started, session_id[:8],
            )
            threading.Thread(target=unwedge, args=(session_id, tool_name, time.time() - started), daemon=True, name="unwedge").start()
            arm_retry(getattr(ctx, "session", None))
        elif settled_streak["n"] >= 3:
            # Stage 3, measured necessary on the live specimen: a CLI blocked 20+ minutes never
            # noticed the killed sidecar (no respawn, no error on the pending call), so the retry
            # armed above can never fire; the turn has to be ENDED for anything to move. A
            # cancelled turn skips the continuation hook by design, so dispatch the retry here.
            logger.warning("delegation recovery stage 3: force-ending the wedged turn on %s", session_id[:8])
            loop.create_task(p_force_recover(session_id, getattr(ctx, "session", None)))
            return
        loop.call_later(DELEGATION_CHECK_SECONDS, p_check)

    loop.call_later(DELEGATION_CHECK_SECONDS, p_check)


async def p_force_recover(session_id: str, session: object) -> None:
    from backend.apps.agents.agent_manager import agent_manager
    try:
        if session is not None:
            try:
                session.pending_continuation = False          # type: ignore[attr-defined]
                session.pending_continuation_prompt = None    # type: ignore[attr-defined]
            except Exception:
                pass
        await agent_manager.stop_agent(session_id)
        await asyncio.sleep(2)
        await agent_manager.send_message(session_id, RETRY_PROMPT, hidden=True)
    except Exception:
        logger.exception("delegation stage-3 recovery failed for %s", session_id[:8])
