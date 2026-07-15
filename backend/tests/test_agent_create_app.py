"""CreateApp's backend (/outputs/agent-create): seeds a webapp-template workspace,
registers an Output linked to the calling session, names it (row + meta.json in
agreement), broadcasts the upsert the dashboard listens for, and returns the
workspace path + the App Builder reference the MCP tool hands to the agent."""

import json
import os

import pytest

from backend.apps.outputs.models import AgentCreateAppRequest
from backend.apps.outputs.outputs import agent_create_app
from backend.apps.outputs.workspace_io import load as load_output


@pytest.mark.asyncio
async def test_agent_create_registers_named_output_and_broadcasts(tmp_path, monkeypatch):
    import backend.apps.outputs.outputs as outputs_mod
    monkeypatch.setattr(outputs_mod, "WORKSPACE_DIR", str(tmp_path / "ws"))
    monkeypatch.setattr(outputs_mod, "DATA_DIR", str(tmp_path / "data"))
    # workspace_io persists Output rows into its own DATA_DIR; isolate it too.
    import backend.apps.outputs.workspace_io as wio
    monkeypatch.setattr(wio, "DATA_DIR", str(tmp_path / "data"))
    os.makedirs(str(tmp_path / "data"), exist_ok=True)
    broadcasts: list = []
    from backend.apps.agents.core.ws_manager import ws_manager

    async def p_fake_broadcast(event, data):
        broadcasts.append((event, data))
    monkeypatch.setattr(ws_manager, "broadcast_global", p_fake_broadcast)

    res = await agent_create_app(AgentCreateAppRequest(
        name="Pomodoro Timer", description="a timer", parent_session_id="sess-1",
    ))
    assert res["ok"] is True
    assert os.path.isfile(os.path.join(res["path"], "run.sh"))
    # The reference is NOT inlined in the response (context-rot fix) — it's on disk as SKILL.md for the agent to read on demand.
    assert "skill" not in res
    skill_path = os.path.join(res["path"], "SKILL.md")
    assert os.path.isfile(skill_path)
    assert len(open(skill_path, encoding="utf-8").read()) > 500

    output = load_output(res["output_id"])
    assert output.name == "Pomodoro Timer"
    assert output.session_id == "sess-1"
    with open(os.path.join(res["path"], "meta.json"), encoding="utf-8") as f:
        meta = json.load(f)
    assert meta["name"] == "Pomodoro Timer"
    assert broadcasts and broadcasts[0][0] == "agent:output_upserted"
    assert broadcasts[0][1]["output"]["id"] == res["output_id"]
