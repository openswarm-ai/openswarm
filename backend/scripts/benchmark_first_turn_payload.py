#!/usr/bin/env python3
"""Benchmark first-turn prompt payload size with a dummy connector.

This does not contact Claude, Codex, Gemini, or 9Router. It exercises the same
local first-turn surface selector and ledger used by the backend, then prints
the character payload the dummy connector would receive for optimized vs.
legacy first-turn behavior.

Run from the repository root:
    PYTHONPATH=. python backend/scripts/benchmark_first_turn_payload.py
"""

from __future__ import annotations

import json
import contextlib
import io
import os
import sys
import tempfile
from contextlib import contextmanager
from typing import Any

os.environ.setdefault("OPENSWARM_DATA_DIR", tempfile.mkdtemp(prefix="openswarm-bench-"))
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEBUGGER = os.path.join(ROOT, "debugger")
if DEBUGGER not in sys.path:
    sys.path.insert(0, DEBUGGER)


@contextmanager
def env(name: str, value: str | None):
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
    def send(self, *, prompt_content: Any, composed_prompt: str | None, mcp_servers: dict,
             allowed_tools: list[str], disallowed_tools: list[str], surface: dict) -> dict:
        with contextlib.redirect_stdout(io.StringIO()):
            from backend.apps.agents.agent_manager import AgentManager

        return AgentManager()._build_prompt_payload_ledger(
            prompt_content=prompt_content,
            composed_prompt=composed_prompt,
            mcp_servers=mcp_servers,
            effective_allowed=allowed_tools,
            effective_disallowed=disallowed_tools,
            surface=surface,
        )


def mcp_config(script: str) -> dict:
    return {
        "command": "python",
        "args": [script],
        "env": {
            "OPENSWARM_PORT": "8324",
            "OPENSWARM_AUTH_TOKEN": "dummy",
            "OPENSWARM_PARENT_SESSION_ID": "benchmark",
        },
        "type": "stdio",
    }


def make_session():
    with contextlib.redirect_stdout(io.StringIO()):
        from backend.apps.agents.models import AgentSession, Message
        from backend.apps.agents.agent_manager import get_all_tool_names

    session = AgentSession(
        id="benchmark",
        name="Benchmark",
        model="sonnet",
        mode="agent",
        allowed_tools=get_all_tool_names(),
        cwd="/tmp",
    )
    session.messages.append(Message(role="user", content="placeholder"))
    return session


def measure(prompt: str, *, legacy: bool) -> dict:
    with contextlib.redirect_stdout(io.StringIO()):
        from backend.apps.agents.agent_manager import AgentManager
        from backend.apps.settings.models import DEFAULT_SYSTEM_PROMPT

    mgr = AgentManager()
    session = make_session()

    with env("OPENSWARM_DISABLE_FIRST_TURN_MINIMAL", "1" if legacy else None):
        surface = mgr._select_turn_surface(session, prompt)
        outputs_ctx = "<available_views>\n- demo **Demo view**\n</available_views>" if surface["include_outputs_context"] else None
        mcp_registry_ctx = "<mcp_servers>\n- `gmail` - Gmail integration\n</mcp_servers>" if surface["include_mcp_registry"] else None
        composed_prompt = mgr._compose_system_prompt(
            DEFAULT_SYSTEM_PROMPT,
            None,
            None,
            None,
            outputs_ctx,
            None,
            mcp_registry_ctx,
        )

        mcp_servers = {}
        if surface["include_browser_tools"]:
            mcp_servers["openswarm-browser-agent"] = mcp_config("browser_agent_mcp_server.py")
        if surface["include_invoke_tools"]:
            mcp_servers["openswarm-invoke-agent"] = mcp_config("invoke_agent_mcp_server.py")
        if surface["include_mcp_meta"]:
            mcp_servers["openswarm-mcp-meta"] = mcp_config("mcp_meta_server.py")
        if surface["include_outputs_meta"]:
            mcp_servers["openswarm-outputs-meta"] = mcp_config("outputs_meta_server.py")

        allowed = [t for t in surface["allowed_tools"] if not t.startswith("mcp:")]
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

        return DummyAgentConnector().send(
            prompt_content=prompt,
            composed_prompt=composed_prompt,
            mcp_servers=mcp_servers,
            allowed_tools=allowed,
            disallowed_tools=[],
            surface=surface,
        )


def main():
    prompts = [
        "Summarize the repository structure.",
        "Search the web for current pricing.",
        "Send an email through Gmail.",
        "Open the browser and click the login button.",
        "Render this as a dashboard view.",
    ]
    rows = []
    for prompt in prompts:
        optimized = measure(prompt, legacy=False)
        legacy = measure(prompt, legacy=True)
        opt_chars = optimized["chars"]["visible_total"]
        leg_chars = legacy["chars"]["visible_total"]
        rows.append({
            "prompt": prompt,
            "optimized_chars": opt_chars,
            "legacy_chars": leg_chars,
            "saved_chars": leg_chars - opt_chars,
            "saved_pct": round((leg_chars - opt_chars) / leg_chars * 100, 1) if leg_chars else 0,
            "optimized_mcp_servers": optimized["counts"]["mcp_servers"],
            "legacy_mcp_servers": legacy["counts"]["mcp_servers"],
            "optimized_intent": optimized["intent"],
        })
    print(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
