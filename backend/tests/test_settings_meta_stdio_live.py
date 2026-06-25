"""Definitive proof: a SettingsWrite from the REAL stdio MCP server, against a
REAL running backend, on a REAL session whose model is powered by a specific
API key, refuses to clear THAT key but clears a different provider's key.

Earlier coverage either drove the endpoint with an injected session (skipping the
stdio subprocess) or drove the stdio subprocess with no session (hitting the
fail-safe). This closes the gap: it boots uvicorn in-process (so the subprocess's
HTTP call lands on a backend whose `agent_manager.sessions` we can populate),
then runs `settings_meta_server.py` exactly as an agent would. No model required,
the guard is provider-routing logic, not an LLM call.
"""

from __future__ import annotations

import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time

import pytest
import uvicorn

from backend.main import app

SERVER = os.path.join(os.path.dirname(os.path.dirname(__file__)), "apps", "agents", "settings_meta_server.py")


def p_free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def live_backend():
    import backend.auth as auth_mod
    if not auth_mod.TOKEN:
        auth_mod.TOKEN = secrets.token_urlsafe(32)
    port = p_free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(200):
        if getattr(server, "started", False):
            break
        time.sleep(0.05)
    assert getattr(server, "started", False), "uvicorn did not start"
    yield port, auth_mod.TOKEN
    server.should_exit = True
    thread.join(timeout=5)


@pytest.fixture
def reset_settings():
    from backend.apps.settings.settings import load_settings, save_settings
    original = load_settings().model_copy(deep=True)
    yield
    save_settings(original)


def p_run_stdio(port: int, token: str, session_id: str, changes: dict) -> str:
    env = {
        **os.environ,
        "OPENSWARM_PORT": str(port),
        "OPENSWARM_AUTH_TOKEN": token,
        "OPENSWARM_PARENT_SESSION_ID": session_id,
    }
    rpc = "\n".join([
        json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
        json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": {"name": "SettingsWrite", "arguments": {"changes": changes}}}),
    ]) + "\n"
    proc = subprocess.run([sys.executable, SERVER], input=rpc, capture_output=True, text=True, env=env, timeout=30)
    msgs = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    resp = next(m for m in msgs if m.get("id") == 2)
    return resp["result"]["content"][0]["text"]


def test_live_stdio_settingswrite_refuses_live_key_clears_other(live_backend, reset_settings):
    port, token = live_backend
    from backend.apps.settings.settings import load_settings, save_settings
    from backend.apps.agents.agent_manager import agent_manager
    from backend.apps.agents.core.models import AgentSession

    # A real run on opus-4-8 in own_key mode: the Anthropic key powers it; an OpenAI key is also connected (the "other provider").
    s = load_settings()
    s.connection_mode = "own_key"
    s.anthropic_api_key = "sk-ant-LIVE-do-not-clear"
    s.openai_api_key = "sk-oai-OTHER-ok-to-clear"
    save_settings(s)
    agent_manager.sessions["live-stdio-test"] = AgentSession(id="live-stdio-test", name="t", model="opus-4-8")

    try:
        text = p_run_stdio(port, token, "live-stdio-test",
                          {"anthropic_api_key": "", "openai_api_key": "", "theme": "light"})
    finally:
        agent_manager.sessions.pop("live-stdio-test", None)

    # The tool's own rendered result, exactly what the agent would read.
    assert "Refused anthropic_api_key" in text, text
    assert "powering this run" in text
    assert "Applied" in text and "theme" in text

    # And the truth on disk: live key kept, other cleared, benign applied.
    final = load_settings()
    assert final.anthropic_api_key == "sk-ant-LIVE-do-not-clear", "live key was cleared!"
    assert not final.openai_api_key, "the other provider's key should have been cleared"
    assert final.theme == "light"
