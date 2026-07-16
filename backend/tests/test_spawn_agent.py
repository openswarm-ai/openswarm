"""SpawnAgent: the native replacement for the CLI's built-in Agent tool. The child is a
fresh session inheriting the parent's model/cwd/dashboard; sync waits and returns the last
assistant text, background returns immediately. The builtin stays blocked so the model only
ever sees the two-arg schema."""
import asyncio
import json
import subprocess
import sys
from typing import Dict, List, Optional

from pytest import MonkeyPatch, raises

from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentSession, Message


def seed_parent() -> AgentSession:
    parent = AgentSession(name="parent", model="opus-4-8", cwd="/tmp/pw", dashboard_id="dashX")
    agent_manager.sessions[parent.id] = parent
    return parent


def test_spawn_agent_sync_returns_child_answer(monkeypatch: MonkeyPatch) -> None:
    parent = seed_parent()

    async def fake_loop(session_id: str, prompt: str, **kwargs: object) -> None:
        s = agent_manager.sessions[session_id]
        s.messages.append(Message(role="assistant", content="child says done", branch_id=s.active_branch_id))
        s.status = "completed"

    monkeypatch.setattr(agent_manager, "run_agent_loop", fake_loop)
    result = asyncio.run(agent_manager.spawn_agent(prompt="do the thing", parent_session_id=parent.id))

    child = agent_manager.sessions[result["session_id"]]
    assert result["response"] == "child says done"
    assert child.mode == "sub-agent"
    assert child.parent_session_id == parent.id
    assert child.model == parent.model
    assert child.cwd == parent.cwd
    assert child.dashboard_id == "dashX"
    assert child.messages[0].role == "user" and child.messages[0].content == "do the thing"


def test_spawn_agent_background_returns_immediately(monkeypatch: MonkeyPatch) -> None:
    parent = seed_parent()
    started: List[str] = []

    async def slow_loop(session_id: str, prompt: str, **kwargs: object) -> None:
        started.append(session_id)
        await asyncio.sleep(30)

    monkeypatch.setattr(agent_manager, "run_agent_loop", slow_loop)

    async def run() -> Dict:
        result = await asyncio.wait_for(
            agent_manager.spawn_agent(prompt="long task", parent_session_id=parent.id, run_in_background=True),
            timeout=2.0,
        )
        await asyncio.sleep(0.05)
        agent_manager.tasks[result["session_id"]].cancel()
        return result

    result = asyncio.run(run())
    assert result["background"] is True
    assert started == [result["session_id"]]


def test_spawn_agent_unknown_parent_raises() -> None:
    with raises(ValueError):
        asyncio.run(agent_manager.spawn_agent(prompt="x", parent_session_id="nope-" + "0" * 28))


def test_builtin_subagent_tools_stay_blocked() -> None:
    # The CLI's built-in sub-agent tool (Task on 2.1.122, Agent on older builds) must not be offered: out of the catalog AND hard-blocked at the SDK layer.
    from backend.apps.agents.manager.prompt.tool_catalog import FULL_TOOLS
    assert "Agent" not in FULL_TOOLS
    assert "Task" not in FULL_TOOLS
    import inspect
    from backend.apps.agents.manager.run import RunOptions
    src = inspect.getsource(RunOptions)
    block = src.split('disallowed_tools"] = [')[1][:400]
    assert '"Agent",' in block and '"Task",' in block


def test_spawn_server_schema_is_prompt_plus_background_only() -> None:
    from backend.apps.agents import spawn_agent_mcp_server as srv
    tool = srv.TOOLS[0]
    assert tool["name"] == "SpawnAgent"
    assert set(tool["inputSchema"]["properties"].keys()) == {"prompt", "run_in_background"}
    assert tool["inputSchema"]["required"] == ["prompt"]


def test_spawn_server_speaks_mcp_stdio() -> None:
    proc = subprocess.Popen(
        [sys.executable, "backend/apps/agents/spawn_agent_mcp_server.py"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    try:
        msgs = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        ]
        out, _ = proc.communicate("\n".join(json.dumps(m) for m in msgs) + "\n", timeout=15)
        lines = [json.loads(line) for line in out.strip().splitlines()]
        assert lines[0]["result"]["serverInfo"]["name"] == "openswarm-spawn-agent"
        assert lines[1]["result"]["tools"][0]["name"] == "SpawnAgent"
    finally:
        proc.kill()
