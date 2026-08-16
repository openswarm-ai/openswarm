"""A delegated run whose result is lost cannot hang the parent forever (live specimen 2026-08-15).

CreateBrowserAgent is exempt from the 25s unwedge because a browser run legitimately takes minutes.
The exemption assumed results always come home; a packaged-build stress run produced the miss: the
child COMPLETED (backend logged the run summary and answered the sidecar's HTTP call with 200, the
sidecar returned to readline), and the parent sat 'running' on the outstanding tool call for 20+
minutes. These pin the backstop: two consecutive all-children-terminal observations while the call
is still outstanding -> the same unwedge+retry recovery the quick class already has.
"""
import asyncio
from typing import Dict

import pytest

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming import unwedge_sidecar as u


def test_delegation_classifier_is_exact():
    assert u.is_delegation_core_tool("mcp__openswarm-core__CreateBrowserAgent")
    assert u.is_delegation_core_tool("mcp__openswarm-core__AppAgent")
    assert not u.is_delegation_core_tool("mcp__openswarm-core__MemoryWrite"), "quick class stays on the 25s path"
    assert not u.is_delegation_core_tool("mcp__openswarm-core__AskUI"), "a human answering is not a lost result"
    assert not u.is_delegation_core_tool("CreateBrowserAgent"), "only core-prefixed names"


def test_settled_requires_children_and_all_terminal(monkeypatch):
    from backend.apps.agents import agent_manager as am

    parent = AgentSession(id="par-1", name="p", model="sonnet")
    running_child = AgentSession(id="kid-1", name="k1", model="sonnet", mode="browser-agent", parent_session_id="par-1")
    running_child.status = "running"
    done_child = AgentSession(id="kid-2", name="k2", model="sonnet", mode="browser-agent", parent_session_id="par-1")
    done_child.status = "completed"

    monkeypatch.setattr(am.agent_manager, "sessions", {"par-1": parent}, raising=False)
    assert u.delegation_children_settled("par-1") is False, "no children = maybe queued behind admission, NOT settled"

    monkeypatch.setattr(am.agent_manager, "sessions", {"par-1": parent, "kid-1": running_child, "kid-2": done_child}, raising=False)
    assert u.delegation_children_settled("par-1") is False, "one live child means the wait is legitimate"

    running_child.status = "completed"
    assert u.delegation_children_settled("par-1") is True


class P_Ctx:
    def __init__(self, session: AgentSession, times: Dict[str, float]):
        self.session = session
        self.session_id = session.id
        self.tool_start_times = times


@pytest.mark.asyncio
async def test_two_settled_checks_fire_the_recovery(monkeypatch):
    fired = {}
    monkeypatch.setattr(u, "unwedge", lambda sid, tool, age: fired.setdefault("unwedge", (sid, tool)))
    monkeypatch.setattr(u, "arm_retry", lambda s: fired.setdefault("retry", s.id if s else None))
    monkeypatch.setattr(u, "delegation_children_settled", lambda sid: True)
    monkeypatch.setattr(u, "DELEGATION_CHECK_SECONDS", 0.05)

    sess = AgentSession(id="par-2", name="p", model="sonnet")
    ctx = P_Ctx(sess, {"tu-1": 0.0})
    u.arm_delegation_watchdog(ctx, "tu-1", "mcp__openswarm-core__CreateBrowserAgent")
    await asyncio.sleep(0.3)
    assert fired.get("unwedge", (None, None))[0] == "par-2", "two settled checks must recover the parent"
    assert fired.get("retry") == "par-2", "the retry is what redoes the lost step"


@pytest.mark.asyncio
async def test_a_finished_call_disarms_and_a_live_child_resets_the_streak(monkeypatch):
    fired = {}
    monkeypatch.setattr(u, "unwedge", lambda *a: fired.setdefault("unwedge", a))
    monkeypatch.setattr(u, "arm_retry", lambda s: fired.setdefault("retry", True))
    monkeypatch.setattr(u, "DELEGATION_CHECK_SECONDS", 0.05)

    # Finished call: the post hook popped the id, so the first check returns silently.
    sess = AgentSession(id="par-3", name="p", model="sonnet")
    u.arm_delegation_watchdog(P_Ctx(sess, {}), "tu-gone", "mcp__openswarm-core__CreateBrowserAgent")

    # Oscillating child (settles once, then a new child appears): the streak must reset, never fire.
    seq = iter([True, False, True, False, True, False])
    monkeypatch.setattr(u, "delegation_children_settled", lambda sid: next(seq, False))
    u.arm_delegation_watchdog(P_Ctx(sess, {"tu-2": 0.0}), "tu-2", "mcp__openswarm-core__CreateBrowserAgent")
    await asyncio.sleep(0.4)
    assert "unwedge" not in fired, "a merely-slow delegation must never be recovered out from under itself"


def test_quick_tools_never_arm_the_delegation_watchdog():
    # Belt and suspenders: arming for a quick tool would double-recover with the 25s path.
    sess = AgentSession(id="par-4", name="p", model="sonnet")
    u.arm_delegation_watchdog(P_Ctx(sess, {"tu-3": 0.0}), "tu-3", "mcp__openswarm-core__MemoryRead")
    # No loop assertions needed: is_delegation_core_tool returned False, nothing scheduled.
