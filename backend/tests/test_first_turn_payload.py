from __future__ import annotations

import json
import os
import sys
import tempfile
from contextlib import contextmanager
from typing import Any

import pytest

_TMPROOT = tempfile.mkdtemp(prefix="openswarm-first-turn-payload-")
os.environ.setdefault("OPENSWARM_DATA_DIR", _TMPROOT)
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_DEBUGGER = os.path.join(_ROOT, "debugger")
if _DEBUGGER not in sys.path:
    sys.path.insert(0, _DEBUGGER)


@contextmanager
def _env(name: str, value: str | None):
    old = os.environ.get(name)
    if value is None:
        os.environ.pop(name, None)
    else:
        os.environ[name] = value
    try:
        yield
    finally:
        if old is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = old


class DummyAgentConnector:
    """Fake connector that reports how many chars the agent turn receives."""

    def send(self, *, prompt_content: Any, composed_prompt: str | None, mcp_servers: dict,
             allowed_tools: list[str], disallowed_tools: list[str], surface: dict) -> dict:
        from backend.apps.agents.agent_manager import AgentManager

        return AgentManager()._build_prompt_payload_ledger(
            prompt_content=prompt_content,
            composed_prompt=composed_prompt,
            mcp_servers=mcp_servers,
            effective_allowed=allowed_tools,
            effective_disallowed=disallowed_tools,
            surface=surface,
        )


def _session():
    from backend.apps.agents.models import AgentSession, Message
    from backend.apps.agents.agent_manager import get_all_tool_names

    s = AgentSession(
        id="s1",
        name="Test",
        model="sonnet",
        mode="agent",
        allowed_tools=get_all_tool_names(),
        cwd="/tmp",
    )
    s.messages.append(Message(role="user", content="placeholder"))
    return s


def _mcp_config(name: str) -> dict:
    return {
        "command": "python",
        "args": [f"{name}.py"],
        "env": {
            "OPENSWARM_PORT": "8324",
            "OPENSWARM_AUTH_TOKEN": "dummy",
            "OPENSWARM_PARENT_SESSION_ID": "s1",
        },
        "type": "stdio",
    }


def _payload_for(prompt: str, *, legacy: bool = False, selected_browser_ids: list[str] | None = None):
    from backend.apps.agents.agent_manager import AgentManager
    from backend.apps.settings.models import DEFAULT_SYSTEM_PROMPT

    mgr = AgentManager()
    s = _session()
    connector = DummyAgentConnector()

    with _env("OPENSWARM_DISABLE_FIRST_TURN_MINIMAL", "1" if legacy else None):
        surface = mgr._select_turn_surface(
            s,
            prompt,
            selected_browser_ids=selected_browser_ids,
        )
        outputs_ctx = "<available_views>\n- demo **Demo view**\n</available_views>" if surface["include_outputs_context"] else None
        browser_ctx = mgr._build_browser_context("missing-dashboard", selected_browser_ids=selected_browser_ids) if surface["include_browser_context"] else None
        mcp_registry_ctx = "<mcp_servers>\n- `gmail` - Gmail integration\n</mcp_servers>" if surface["include_mcp_registry"] else None
        composed = mgr._compose_system_prompt(
            DEFAULT_SYSTEM_PROMPT,
            None,
            None,
            None,
            outputs_ctx,
            browser_ctx,
            mcp_registry_ctx,
        )
        mcp_servers = {}
        if surface["include_browser_tools"]:
            mcp_servers["openswarm-browser-agent"] = _mcp_config("browser_agent_mcp_server")
        if surface["include_invoke_tools"]:
            mcp_servers["openswarm-invoke-agent"] = _mcp_config("invoke_agent_mcp_server")
        if surface["include_mcp_meta"]:
            mcp_servers["openswarm-mcp-meta"] = _mcp_config("mcp_meta_server")
        if surface["include_outputs_meta"]:
            mcp_servers["openswarm-outputs-meta"] = _mcp_config("outputs_meta_server")

        builtin_perms = {}
        allowed = [t for t in surface["allowed_tools"] if not t.startswith("mcp:") and builtin_perms.get(t, "always_allow") == "always_allow"]
        disallowed = []
        for name in mcp_servers:
            if name == "openswarm-browser-agent":
                allowed.extend([
                    "mcp__openswarm-browser-agent__CreateBrowserAgent",
                    "mcp__openswarm-browser-agent__BrowserAgent",
                    "mcp__openswarm-browser-agent__BrowserAgents",
                ])
            elif name == "openswarm-invoke-agent":
                allowed.append("mcp__openswarm-invoke-agent__InvokeAgent")
            else:
                allowed.append(f"mcp__{name}__*")

        return connector.send(
            prompt_content=prompt,
            composed_prompt=composed,
            mcp_servers=mcp_servers,
            allowed_tools=allowed,
            disallowed_tools=disallowed,
            surface=surface,
        )


def test_plain_first_message_uses_minimal_surface_and_reduces_chars():
    prompt = "Summarize the repository structure."
    optimized = _payload_for(prompt)
    legacy = _payload_for(prompt, legacy=True)

    assert optimized["optimized"] is True
    assert optimized["counts"]["mcp_servers"] == 0
    assert legacy["counts"]["mcp_servers"] >= 4
    assert optimized["chars"]["visible_total"] < legacy["chars"]["visible_total"] * 0.55


@pytest.mark.parametrize(
    ("prompt", "expected"),
    [
        ("Search the web for current pricing", {"web"}),
        ("Send an email through Gmail", {"mcp"}),
        ("Render this as a dashboard view", {"outputs"}),
        ("Open the browser and click the login button", {"browser"}),
        ("Run this every day at 9am", {"cron"}),
        ("Ask another agent to inspect this", {"invoke"}),
    ],
)
def test_router_preserves_relevant_capability_on_first_turn(prompt, expected):
    payload = _payload_for(prompt)
    intent = {k for k, v in payload["intent"].items() if v}
    assert expected <= intent

    if expected & {"mcp", "outputs", "browser", "invoke"}:
        assert payload["counts"]["mcp_servers"] >= 1


def test_followup_turn_keeps_full_surface_for_compatibility():
    from backend.apps.agents.models import Message
    from backend.apps.agents.agent_manager import AgentManager

    mgr = AgentManager()
    s = _session()
    s.sdk_session_id = "sdk-session"
    s.messages.append(Message(role="assistant", content="ok"))
    surface = mgr._select_turn_surface(s, "Continue")
    assert surface["optimized"] is False
    assert surface["include_browser_tools"] is True
    assert surface["include_mcp_meta"] is True
    assert surface["include_outputs_meta"] is True


def test_forced_tools_pull_in_matching_lazy_surface():
    from backend.apps.agents.agent_manager import AgentManager

    mgr = AgentManager()
    s = _session()
    surface = mgr._select_turn_surface(s, "Do this", forced_tools=["RenderOutput", "BrowserAgent"])
    assert surface["optimized"] is True
    assert surface["include_outputs_meta"] is True
    assert surface["include_browser_tools"] is True
    assert "RenderOutput" in surface["allowed_tools"]
    assert "BrowserAgent" in surface["allowed_tools"]
