"""The unwedge envelope must say what the children looked like at the kill.

Haik's install: 154 CreateBrowserAgent kills in 14 days at a 150 s floor, and the envelope carried
only tool, seconds and pids, so nobody could tell "child finished, result lost" (recovery by design)
from "child died first" (a different bug). One shared helper feeds the watchdog's settled test AND the
envelope, so the two can never disagree about which children count."""
import datetime
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.streaming import unwedge_sidecar as us
from backend.apps.agents.manager.streaming.delegation_watchdog import delegation_children_settled
from backend.apps.service import client as svc


def p_child(parent_id: str, status: str, born_ago_s: float) -> AgentSession:
    s = AgentSession(name="Browser Agent", model="sonnet", mode="browser-agent", status=status)
    s.parent_session_id = parent_id
    s.created_at = datetime.datetime.now() - datetime.timedelta(seconds=born_ago_s)
    return s


def test_the_envelope_carries_each_child_status_and_age(monkeypatch) -> None:
    parent = AgentSession(name="p", model="sonnet")
    agent_manager.sessions.clear(); agent_manager.sessions[parent.id] = parent
    for kid in (p_child(parent.id, "completed", 30), p_child(parent.id, "error", 10), p_child(parent.id, "running", 5), p_child(parent.id, "completed", 900)):
        agent_manager.sessions[kid.id] = kid
    sent: list = []
    monkeypatch.setattr(svc, "submit_diagnostic", lambda d: sent.append(d))
    monkeypatch.setattr(us, "find_sidecar_pids", lambda sid: [424242])
    monkeypatch.setattr(us.subprocess, "run", lambda *a, **k: None)
    monkeypatch.setattr(us.time, "sleep", lambda s: None)
    us.unwedge(parent.id, "mcp__openswarm-core__CreateBrowserAgent", 150.0)
    env = [d for d in sent if isinstance(d, dict) and d.get("kind") == "mcp_sidecar_unwedged"]
    assert len(env) == 1
    kids = env[0]["children"]
    assert sorted(k["status"] for k in kids) == ["completed", "error", "running"], "only children born after the call started; the 900 s one is an earlier delegation's"
    assert all(isinstance(k["age_s"], float) for k in kids)


def test_the_watchdog_and_the_envelope_count_the_same_children() -> None:
    parent = AgentSession(name="p", model="sonnet")
    agent_manager.sessions.clear(); agent_manager.sessions[parent.id] = parent
    agent_manager.sessions.update({k.id: k for k in (p_child(parent.id, "completed", 20), p_child(parent.id, "completed", 600))})
    import time
    since = time.time() - 100
    assert len(us.delegation_children_born_after(parent.id, since)) == 1
    assert delegation_children_settled(parent.id, since) is True
    assert len(us.children_summary(parent.id, since)) == 1
