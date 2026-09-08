"""Eric's board, 2026-08-26: a parent on Opus 5 spawned 21 transcription children over an hour; 14 died on the
policy filter and the parent re-dispatched each one with a rephrased prompt, because the return said only
"No response from sub-agent." The child now says it was declined, and a third spawn after two declines is refused."""

import asyncio
from datetime import datetime, timedelta

from pytest import MonkeyPatch

from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.SpawnAgentRun import DECLINED_CHILDREN_CAP, child_reply, declined_children_this_turn


def p_parent() -> AgentSession:
    parent = AgentSession(name="parent", model="opus-5", cwd="/tmp/pw", dashboard_id="dashX")
    parent.messages.append(Message(role="user", content="transcribe the book"))
    agent_manager.sessions[parent.id] = parent
    return parent


def p_declined_child(parent: AgentSession, born: datetime) -> AgentSession:
    child = AgentSession(name="child", model="opus-5", mode="sub-agent", parent_session_id=parent.id, status="error", created_at=born)
    child.last_failure_kind = "policy_block"
    agent_manager.sessions[child.id] = child
    return child


def test_a_declined_child_tells_the_parent_not_to_spawn_another(monkeypatch: MonkeyPatch) -> None:
    parent = p_parent()

    async def blocked_loop(session_id: str, prompt: str, **kwargs: object) -> None:
        s = agent_manager.sessions[session_id]
        s.messages.append(Message(role="assistant", content="Starting on page 6.", branch_id=s.active_branch_id))
        s.status = "error"
        s.last_failure_kind = "policy_block"

    monkeypatch.setattr(agent_manager, "run_agent_loop", blocked_loop)
    result = asyncio.run(agent_manager.spawn_agent(prompt="transcribe pages 6-14", parent_session_id=parent.id))
    assert result["status"] == "error"
    assert "declined" in result["response"] and "do not spawn another" in result["response"]
    assert "Starting on page 6." in result["response"], "the partial note still comes home"
    assert "No response from sub-agent" not in result["response"]


def test_a_third_spawn_after_two_declines_this_turn_is_refused(monkeypatch: MonkeyPatch) -> None:
    parent = p_parent()
    now = datetime.now()
    for _ in range(DECLINED_CHILDREN_CAP):
        p_declined_child(parent, now + timedelta(seconds=1))
    spawned: list[str] = []

    async def loop(session_id: str, prompt: str, **kwargs: object) -> None:
        spawned.append(session_id)

    monkeypatch.setattr(agent_manager, "run_agent_loop", loop)
    result = asyncio.run(agent_manager.spawn_agent(prompt="transcribe pages 6-14 again", parent_session_id=parent.id))
    assert "error" in result and "declined" in result["error"]
    assert spawned == [], "no child is born for a task the filter already declined twice"


def test_declines_before_the_users_latest_message_do_not_count(monkeypatch: MonkeyPatch) -> None:
    """A new ask is a new turn: the user may have changed the task, so the cap resets on their message."""
    parent = p_parent()
    old = datetime.now() - timedelta(minutes=5)
    for _ in range(DECLINED_CHILDREN_CAP):
        p_declined_child(parent, old)
    parent.messages.append(Message(role="user", content="try a different approach"))
    assert declined_children_this_turn(agent_manager.sessions, parent) == []
    spawned: list[str] = []

    async def loop(session_id: str, prompt: str, **kwargs: object) -> None:
        spawned.append(session_id)
        agent_manager.sessions[session_id].status = "completed"

    monkeypatch.setattr(agent_manager, "run_agent_loop", loop)
    result = asyncio.run(agent_manager.spawn_agent(prompt="summarise instead", parent_session_id=parent.id))
    assert len(spawned) == 1 and result["status"] == "completed"


def test_a_clean_child_reply_is_unchanged() -> None:
    child = AgentSession(name="c", model="opus-5", mode="sub-agent")
    child.messages.append(Message(role="assistant", content="9 phonemes: 6 to 14."))
    assert child_reply(child) == "9 phonemes: 6 to 14."
    assert child_reply(AgentSession(name="e", model="opus-5", mode="sub-agent")) == "No response from sub-agent."


def test_the_stamp_is_set_by_the_policy_card_and_cleared_at_turn_start() -> None:
    import inspect
    from backend.apps.agents.agent_manager import AgentManager
    from backend.apps.agents.manager.run import handle_run_error as hre
    src = inspect.getsource(hre.handle_run_error)
    assert 'session.last_failure_kind = "policy_block"' in src
    assert src.index('session.last_failure_kind = "policy_block"') > src.index("policy_block_sibling("), "only the card path stamps; a failover that continues is not a failure"
    assert "session.last_failure_kind = None" in inspect.getsource(AgentManager.run_agent_loop)
