"""Haik, exp.9: killing a parent left its SpawnAgent children running. Stop, close and delete walked
only browser-agent children, so a sub-agent tree (and anything under it) outlived the parent."""

import asyncio
import inspect

from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager import SessionControl
from backend.apps.agents.manager.session import SessionLifecycle, descendants


def p_tree() -> tuple[AgentSession, AgentSession, AgentSession, AgentSession]:
    parent = AgentSession(name="parent", model="opus-4-8", status="running")
    child = AgentSession(name="child", model="opus-4-8", status="running", mode="sub-agent", parent_session_id=parent.id)
    grandchild = AgentSession(name="grandchild", model="opus-4-8", status="running", mode="browser-agent", parent_session_id=child.id)
    stranger = AgentSession(name="stranger", model="opus-4-8", status="running", mode="sub-agent")
    for s in (parent, child, grandchild, stranger):
        agent_manager.sessions[s.id] = s
    return parent, child, grandchild, stranger


def p_park(session_id: str) -> asyncio.Task:
    async def forever() -> None:
        await asyncio.sleep(3600)
    task = asyncio.get_running_loop().create_task(forever())
    agent_manager.tasks[session_id] = task
    return task


def test_stopping_the_parent_stops_the_whole_tree_and_nobody_else():
    parent, child, grandchild, stranger = p_tree()

    async def run() -> None:
        tasks = [p_park(s.id) for s in (parent, child, grandchild, stranger)]
        await agent_manager.stop_agent(parent.id)
        await asyncio.sleep(0)
        # Checked inside the loop: closing it cancels every task that is left, which would fake the stranger's cancel.
        assert [s.status for s in (parent, child, grandchild)] == ["stopped", "stopped", "stopped"]
        assert stranger.status == "running", "an unrelated running chat is not the tree"
        assert all(t.cancelled() or t.done() for t in tasks[:3])
        assert not tasks[3].cancelled() and not tasks[3].done()
        for s in (parent, child, grandchild):
            assert s.id not in agent_manager.tasks
        tasks[3].cancel()

    asyncio.run(run())


def test_children_of_walks_every_kind_not_just_browser_agents():
    parent, child, grandchild, stranger = p_tree()
    assert [s.id for s in descendants.children_of(agent_manager.sessions, parent.id)] == [child.id]
    assert [s.id for s in descendants.children_of(agent_manager.sessions, child.id)] == [grandchild.id]
    assert descendants.children_of(agent_manager.sessions, stranger.id) == []


def test_close_and_delete_take_the_same_walk():
    """Three doors, one walk: a mode filter in any of them is the bug coming back."""
    for fn in (SessionControl.SessionControl.stop_agent, SessionLifecycle.SessionLifecycle.close_session, SessionLifecycle.SessionLifecycle.delete_session):
        src = inspect.getsource(fn)
        assert "children_of(self.sessions, session_id)" in src, fn.__name__
        assert 'mode == "browser-agent"' not in src, fn.__name__
