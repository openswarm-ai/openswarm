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
from typing import Dict, List, Set

from typeguard import typechecked

logger = logging.getLogger(__name__)

# The quick class answers in MILLISECONDS (memory, settings, schedule CRUD), so 25s is already a
# thousandfold margin: long enough that nothing healthy trips it, short enough that a user reads
# the recovery as a hiccup rather than a hang. Anything that legitimately blocks (a human, a
# delegated run) is exempt by name below, so this deadline never races real work.
WEDGE_SECONDS = 25.0
# A sidecar whose heartbeat still beats is ALIVE with one slow tool, not wedged (measured: 5 healthy-sidecar kills in one loaded evening were every one of Haik's "MCP disconnected" reports, ENG-353); it is re-checked here.
LATE_WEDGE_SECONDS = 120.0
# Still heartbeating at the late deadline means a genuinely long call; only this long dies regardless, so a hung per-call thread cannot hang the session forever (ENG-368).
HARD_WEDGE_SECONDS = 300.0
# A delegated run is a whole other agent doing real work, so five minutes is a deadline for the
# WRONG unit. The exemption above already says these tools may block for as long as the delegated run
# takes, but it only governed the 25s arming: `wedge_verdict` never received the tool name, so the
# ceiling killed them anyway. Measured in the field 2026-09-01: browser runs killed at 450s and 600s
# outstanding on a healthy, heartbeating sidecar, each one ending the turn mute in front of the user.
# The stale-heartbeat rule is untouched and still kills a genuinely dead sidecar in seconds, which is
# the check that actually protects the session; this ceiling is only the backstop for "alive but the
# call never returns", and for a delegated run that has to be measured in the delegated run's units.
DELEGATED_HARD_WEDGE_SECONDS = 1800.0
HEARTBEAT_FRESH_S = 12.0

CORE_PREFIX = "mcp__openswarm-core__"

# Every core tool that may block on a human, a model, or a whole delegated run. A timeout on these
# would be a capability regression, which is worse than the bug.
# Imported, never restated: this set and the registered delegation tools drifted apart once already
# and cost a user weeks of browser runs.
from backend.apps.agents.manager.delegation_tool_names import BLOCKING_TOOLS as P_BLOCKING_TOOLS


@typechecked
def is_quick_core_tool(tool_name: str) -> bool:
    if not tool_name.startswith(CORE_PREFIX):
        return False
    return tool_name[len(CORE_PREFIX):] not in P_BLOCKING_TOOLS


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
def hard_ceiling_for(tool_name: str) -> float:
    """The ceiling in the unit the WORK is measured in: a quick tool answers in milliseconds, a
    delegated run takes as long as the browser/app/agent it handed off to.

    Only a DECLARED delegation tool earns the longer one. An unknown name, an empty one, or a
    non-core tool keeps the strict 300s, so a caller that forgets to pass the name gets today's
    behaviour rather than a silent thirty-minute reprieve. The declared signal is the one shared
    list in delegation_tool_names, which exists because two lists of names that must agree will not.
    """
    if tool_name.startswith(CORE_PREFIX) and tool_name[len(CORE_PREFIX):] in P_BLOCKING_TOOLS:
        return DELEGATED_HARD_WEDGE_SECONDS
    return HARD_WEDGE_SECONDS


@typechecked
def wedge_verdict(outstanding_s: float, hb_age: float, tool_name: str = "") -> str:
    """kill | extend. A stale heartbeat is a wedged PROCESS: kill at whichever deadline sees it. A fresh
    one is a slow call: keep extending until the hard ceiling (a hung thread must not hang the session).

    The ceiling is per-tool, not one global constant: the old single 300s killed healthy delegated
    runs, which is a deadline on the wrong unit of work."""
    if outstanding_s >= hard_ceiling_for(tool_name):
        return "kill"
    if hb_age > HEARTBEAT_FRESH_S:
        return "kill"
    return "extend"


RETRY_PROMPT = (
    "Your last tool call never returned because its server had frozen; that server has been "
    "restarted and works now. Retry that one step, then carry on where you left off."
)


@typechecked
def announce_tool_recovery(session_id: str, tool_name: str, outstanding_s: float) -> None:
    """The one self-heal a user could watch for five minutes and never be told about: the card kept
    its working dot while the sidecar was shot and the step redone. One transient pill, sent from
    the loop thread the watchdog already runs on."""
    try:
        from backend.apps.agents.core.ws_manager import ws_manager
        asyncio.ensure_future(ws_manager.send_to_session(session_id, "agent:tool_recovered", {
            "session_id": session_id,
            "tool": tool_name.replace(CORE_PREFIX, ""),
            "outstanding_s": round(outstanding_s),
        }))
    except Exception:
        logger.debug("tool_recovered announce failed", exc_info=True)


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
def delegation_children_born_after(session_id: str, since: float) -> List[object]:
    """The browser/app children this session spawned after `since`. One definition, shared by the
    watchdog's settled test and the unwedge envelope, so the two can never count different children."""
    from backend.apps.agents.agent_manager import agent_manager
    kids: List[object] = []
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
    return kids


@typechecked
def children_summary(session_id: str, since: float) -> List[Dict[str, object]]:
    """What the children looked like at the moment of a kill: status plus how long ago each was born.
    Haik's 154 CreateBrowserAgent kills could not be split into "child finished, result lost" versus
    "child died first" because the envelope carried only tool, seconds and pids (read 2026-09-01)."""
    now = time.time()
    out: List[Dict[str, object]] = []
    for s in delegation_children_born_after(session_id, since):
        born = getattr(s, "created_at", None)
        try:
            age = round(now - born.timestamp(), 1) if born is not None else None
        except Exception:
            age = None
        out.append({"status": str(getattr(s, "status", "") or ""), "age_s": age, "tools": len(getattr(s, "tool_latencies", {}) or {})})
    return out


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
                "children": children_summary(session_id, time.time() - outstanding_s),
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
        verdict = wedge_verdict(outstanding, heartbeat_age(session_id), tool_name)
        if verdict == "extend":
            p_next = LATE_WEDGE_SECONDS if outstanding < LATE_WEDGE_SECONDS else hard_ceiling_for(tool_name)
            logger.info(
                f"Agent {session_id}: core tool {tool_name} outstanding {outstanding:.0f}s but the "
                f"sidecar heartbeat is fresh (alive, slow); re-checking at {p_next:.0f}s")
            loop.call_later(max(1.0, p_next - outstanding), p_check)
            return
        # ps + kill are blocking; keep them off the event loop. A daemon thread, not the loop's
        # default executor: executor workers are non-daemon and a per-test loop that closes without
        # shutdown leaks them parked forever (the suite's flaky hang at interpreter exit).
        threading.Thread(target=unwedge, args=(session_id, tool_name, outstanding), daemon=True, name="unwedge").start()
        arm_retry(getattr(ctx, "session", None))
        announce_tool_recovery(session_id, tool_name, outstanding)

    loop.call_later(WEDGE_SECONDS, p_check)
