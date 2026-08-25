"""The delegation backstop: a browser/app run whose result never comes home.

Split out of unwedge_sidecar.py, which had grown to hold two different jobs: the 25s quick-tool
wedge deadline, and this, the slow-cadence watchdog for tools that legitimately run for minutes and
are therefore exempt from that deadline.
"""

import asyncio
import logging
import threading
import time
from typing import Set

from typeguard import typechecked

from backend.apps.agents.manager.streaming.unwedge_sidecar import (
    HEARTBEAT_FRESH_S, CORE_PREFIX, RETRY_PROMPT, arm_retry, heartbeat_age, unwedge,
)

logger = logging.getLogger(__name__)


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
    return tool_name.startswith(CORE_PREFIX) and tool_name[len(CORE_PREFIX):] in P_DELEGATION_TOOLS


@typechecked
def delegation_children_settled(session_id: str, since: float) -> bool:
    """True when this session has delegated children born AFTER this tool call started and every one
    of them is terminal. No children yet is NOT settled: a run queued behind the admission cap can
    wait minutes legitimately. The `since` scope is load-bearing: a parent's SECOND delegation used
    to read its first run's terminal children as 'settled' while the new run was still queued, and
    the watchdog shot a healthy sidecar mid-run (39 kills + 40 force-ended turns in one afternoon
    of concurrent load, measured 2026-08-16 on the packaged build)."""
    from backend.apps.agents.agent_manager import agent_manager
    # A user's Stop stops the children first, so they read as terminal and the outstanding call looked like a lost result; stage 3 then force-ended the turn and resent RETRY_PROMPT into the session the user had just stopped, every ~150s (reproduced twice, 2026-08-20). A human ending the parent is not a lost result.
    p_parent = agent_manager.sessions.get(session_id)
    if p_parent is not None and getattr(p_parent, "ended_by_user", False):
        return False
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
def no_child_ever_born(session_id: str, since: float) -> bool:
    """True when this delegation produced no child at all, which is the ONLY case liveness may judge.

    Scoping matters: once a child exists, `delegation_children_settled` already governs and a live
    child must keep the call alive however quiet the sidecar looks. Applying liveness more widely
    killed a run with a healthy child in the existing backstop test, which is the same over-broad
    mistake ENG-327 paid 39 dead sidecars for.
    """
    from backend.apps.agents.agent_manager import agent_manager
    for p_s in agent_manager.sessions.values():
        if getattr(p_s, "parent_session_id", None) != session_id or getattr(p_s, "mode", "") != "browser-agent":
            continue
        p_born = getattr(p_s, "created_at", None)
        try:
            if p_born is not None and p_born.timestamp() >= since:
                return False
        except Exception:
            continue
    return True


@typechecked
def sidecar_is_dead(session_id: str) -> bool:
    """A stale heartbeat means the PROCESS stopped, which no amount of patience fixes.

    Deliberately separate from `delegation_children_settled`: that answers "is the work done", this
    answers "is anything still running". Conflating them is what left a frozen sidecar unbounded.
    An absent heartbeat file (older sidecar builds) reads as dead, matching `wedge_verdict`.
    """
    return heartbeat_age(session_id) > HEARTBEAT_FRESH_S


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
        # A sidecar that froze BEFORE spawning anything produces no children ever, so the settled
        # test above can never become true and the call hangs with no bound at all: exempt from the
        # 25s deadline was silently also exempt from the 300s ceiling. Reported by Haik Decie, whose
        # call only returned when the harness restarted the server by hand. The discriminator is
        # LIVENESS, not time: a run queued behind the admission cap has a beating sidecar and is
        # never touched, while a dead process is an observation rather than a guess (ENG-402).
        if not settled and no_child_ever_born(session_id, started) and sidecar_is_dead(session_id):
            settled = True
            logger.warning(
                "delegation sidecar on %s has not heartbeat in %.0fs with no child ever spawned; "
                "treating as dead rather than slow", session_id[:8], heartbeat_age(session_id))
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
            loop.create_task(force_recover(session_id, getattr(ctx, "session", None)))
            return
        loop.call_later(DELEGATION_CHECK_SECONDS, p_check)

    loop.call_later(DELEGATION_CHECK_SECONDS, p_check)


async def force_recover(session_id: str, session: object) -> None:
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
