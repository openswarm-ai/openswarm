"""Discovery must refuse to spawn a credential-driven MCP server that has no credentials yet.

The Slack case: a tokenless `npx slack-mcp-server` dies at boot and the npm wrapper buries the one
useful line under a Node crash dump, which is exactly the toast users saw. The right answer is a
clean 409 before any spawn, and an untouched spawn path once credentials exist.
"""

from __future__ import annotations

import pytest
from unittest.mock import patch
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture
def client():
    import backend.auth as auth_mod
    if not auth_mod.TOKEN:
        import secrets
        auth_mod.TOKEN = secrets.token_urlsafe(32)
    return TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"})


def p_create_tool(client: TestClient, credentials: dict) -> str:
    res = client.post("/api/tools/create", json={
        "name": "SlackGateTest",
        "description": "gate test",
        "command": "",
        "mcp_config": {"type": "stdio", "command": "npx", "args": ["-y", "slack-mcp-server@1.3.0", "--transport", "stdio"]},
        "credentials": credentials,
        "auth_type": "env_vars",
        "auth_status": "configured",
    })
    assert res.status_code == 200
    return res.json()["tool"]["id"]


def test_credentialless_env_vars_tool_gets_409_and_no_spawn(client):
    tool_id = p_create_tool(client, credentials={})
    try:
        with patch("backend.apps.tools_lib.tools_lib.discover_mcp_tools_stdio") as spawn:
            res = client.post(f"/api/tools/{tool_id}/discover")
        assert res.status_code == 409
        assert "Connect" in res.json()["detail"]
        spawn.assert_not_called()
    finally:
        client.delete(f"/api/tools/{tool_id}")


def test_credentialed_tool_still_reaches_the_spawn_path(client):
    tool_id = p_create_tool(client, credentials={"SLACK_MCP_XOXC_TOKEN": "xoxc-test", "SLACK_MCP_XOXD_TOKEN": "xoxd-test"})
    try:
        async def p_fake_discover(**kwargs):
            assert kwargs["env"]["SLACK_MCP_XOXC_TOKEN"] == "xoxc-test"
            return [{"name": "channels_list", "description": "", "inputSchema": None}]
        with patch("backend.apps.tools_lib.tools_lib.discover_mcp_tools_stdio", side_effect=p_fake_discover):
            res = client.post(f"/api/tools/{tool_id}/discover")
        assert res.status_code == 200
        assert "channels_list" in res.json()["tool"]["tool_permissions"]
    finally:
        client.delete(f"/api/tools/{tool_id}")
