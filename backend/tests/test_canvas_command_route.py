"""ENG-334: the CanvasCommand route's close-guard is the security boundary.

An agent may rearrange the canvas freely, but close is destructive, so the route (not the
renderer, not the tool list) must refuse closing anything the caller does not own: its own card,
a session it spawned, or a browser card it spawned. A client that skips the MCP tool and posts
straight here must hit the same wall."""
import secrets
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def p_client():
    import backend.auth as auth_mod
    from backend.main import app

    if not auth_mod.TOKEN:
        auth_mod.TOKEN = secrets.token_urlsafe(32)
    return TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"})


def test_unknown_action_is_a_400(p_client):
    r = p_client.post("/api/canvas/command", json={"action": "yeet", "parent_session_id": "s1"})
    assert r.status_code == 400


def test_missing_parent_session_is_a_400(p_client):
    r = p_client.post("/api/canvas/command", json={"action": "move", "x": 1, "y": 2})
    assert r.status_code == 400


def test_close_of_a_foreign_card_is_refused(p_client):
    with patch("backend.apps.agents.agent_manager.agent_manager.get_session", return_value=None):
        r = p_client.post("/api/canvas/command", json={
            "action": "close", "card_id": "someone-elses-card", "parent_session_id": "s1",
        })
    assert r.status_code == 403
    assert "your own card" in r.json()["error"]


def test_close_of_own_card_relays_to_the_renderer(p_client):
    relay = AsyncMock(return_value={"text": "Closed agent card s1."})
    with patch("backend.main.ws_manager.send_browser_command", relay):
        r = p_client.post("/api/canvas/command", json={
            "action": "close", "parent_session_id": "s1",
        })
    assert r.status_code == 200
    assert relay.await_count == 1
    p_args = relay.await_args.args
    assert p_args[1] == "canvas_command"
    assert p_args[3]["card_id"] == "s1"


def test_close_of_a_spawned_child_session_is_allowed(p_client):
    class P_Child:
        parent_session_id = "s1"

    relay = AsyncMock(return_value={"text": "Closed."})
    with patch("backend.apps.agents.agent_manager.agent_manager.get_session", return_value=P_Child()), \
         patch("backend.main.ws_manager.send_browser_command", relay):
        r = p_client.post("/api/canvas/command", json={
            "action": "close", "card_id": "child-1", "parent_session_id": "s1",
        })
    assert r.status_code == 200
    assert relay.await_count == 1


def test_move_defaults_to_the_callers_own_card_and_relays(p_client):
    relay = AsyncMock(return_value={"text": "Moved."})
    with patch("backend.main.ws_manager.send_browser_command", relay):
        r = p_client.post("/api/canvas/command", json={
            "action": "move", "parent_session_id": "s1", "x": 120, "y": 80,
        })
    assert r.status_code == 200
    p_params = relay.await_args.args[3]
    assert p_params == {"action": "move", "card_id": "s1", "x": 120, "y": 80, "zone": None}


def test_renderer_error_comes_back_honest_not_200(p_client):
    relay = AsyncMock(return_value={"error": "No dashboard is connected."})
    with patch("backend.main.ws_manager.send_browser_command", relay):
        r = p_client.post("/api/canvas/command", json={
            "action": "tidy", "parent_session_id": "s1",
        })
    assert r.status_code == 502
    assert "error" in r.json()
