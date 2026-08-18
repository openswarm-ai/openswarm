"""A launched-but-quiet session survives a backend crash.

Until its first turn ended (turn snapshot), the chat was closed, or the backend shut down
gracefully, a launched session lived only in memory. After a crash or SIGKILL the respawned
backend had no file to promote into the dashboard's list, the renderer treated that scoped list
as authority, stripped the card, and the debounced layout save persisted the loss (reproduced on
1.7.7 by killing the packaged backend after opening a chat). Launch now snapshots at birth, so a
respawn finds the session the same way it finds one that outlived a graceful shutdown.
"""

import asyncio
import json
import os
from typing import Any

import pytest

import backend.config.paths as config_paths
from backend.apps.agents import agent_manager as agent_manager_module
from backend.apps.agents.agent_manager import agent_manager
from backend.apps.agents.core.models import AgentConfig
from backend.apps.agents.core.ws_manager import ws_manager
from backend.apps.agents.manager.session.session_store import load_session_data


@pytest.fixture()
def isolated_stores(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> dict:
    sessions = tmp_path / "sessions"
    dashboards = tmp_path / "dashboards"
    sessions.mkdir()
    dashboards.mkdir()
    monkeypatch.setattr(agent_manager_module, "SESSIONS_DIR", str(sessions))
    monkeypatch.setattr(config_paths, "DASHBOARDS_DIR", str(dashboards))
    # No socket, no analytics, no git in a temp cwd: the launch path's side channels stay quiet.
    async def p_silent(*args: Any, **kwargs: Any) -> None:
        return None
    monkeypatch.setattr(ws_manager, "send_to_session", p_silent)
    monkeypatch.setattr(agent_manager_module.agent_manager, "prewarm_client", p_silent, raising=False)
    return {"sessions": str(sessions), "dashboards": str(dashboards), "cwd": str(tmp_path / "work")}


def p_launch(config: AgentConfig):
    return asyncio.run(agent_manager.launch_agent(config))


def test_a_fresh_launch_is_on_disk_before_any_turn(isolated_stores: dict) -> None:
    session = p_launch(AgentConfig(name="parked", dashboard_id="d1", target_directory=isolated_stores["cwd"]))
    try:
        data = load_session_data(session.id)
        assert data is not None, "launch must snapshot the session file at birth"
        assert data["id"] == session.id
        assert data["dashboard_id"] == "d1"
        assert data["messages"] == []
    finally:
        agent_manager.sessions.pop(session.id, None)


def test_a_respawned_backend_lists_the_parked_session_for_its_dashboard(isolated_stores: dict) -> None:
    session = p_launch(AgentConfig(name="parked", dashboard_id="d1", target_directory=isolated_stores["cwd"]))
    # The renderer's layout save already put the card on the board (that PUT is what made the wipe
    # permanent before); the respawned backend has an empty session map.
    with open(os.path.join(isolated_stores["dashboards"], "d1.json"), "w", encoding="utf-8") as f:
        json.dump({"layout": {"cards": {session.id: {"session_id": session.id}}}}, f)
    agent_manager.sessions.pop(session.id, None)
    try:
        listed = agent_manager.get_all_sessions(dashboard_id="d1")
        assert [s.id for s in listed] == [session.id]
    finally:
        agent_manager.sessions.pop(session.id, None)
