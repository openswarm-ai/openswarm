"""Direct coverage for build_effective_tool_lists, the per-turn allowed/disallowed tool gate.
The v2 invariants cover it end-to-end via the loop; these pin the pure builder in isolation:
builtin allow/deny resolution and the web-MCP suppression of the native WebSearch/WebFetch."""

import pytest

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.permissions.build_effective_tool_lists import build_effective_tool_lists


def p_session(allowed):
    s = AgentSession(name="t", model="sonnet", dashboard_id="d")
    s.allowed_tools = allowed
    return s


def test_builtin_allow_and_deny_partition():
    session = p_session(["Read", "Write", "Bash"])
    perms = {"Read": "always_allow", "Write": "always_allow", "Bash": "deny"}
    allowed, disallowed = build_effective_tool_lists(session, {}, perms, False, [], [])
    assert "Read" in allowed and "Write" in allowed
    assert "Bash" not in allowed
    assert "Bash" in disallowed  # explicit deny lands on the disallow list


def test_web_mcp_suppresses_native_web_tools():
    session = p_session(["Read", "WebSearch", "WebFetch"])
    perms = {"Read": "always_allow", "WebSearch": "always_allow", "WebFetch": "always_allow"}
    allowed, disallowed = build_effective_tool_lists(session, {}, perms, True, [], [])
    # native WebSearch/WebFetch are stripped (they'd fail) and force-disallowed so the model uses the openswarm-web MCP variants instead
    assert "WebSearch" not in allowed and "WebFetch" not in allowed
    assert "WebSearch" in disallowed and "WebFetch" in disallowed
    assert "Read" in allowed


def test_no_web_mcp_keeps_native_web_tools():
    session = p_session(["WebSearch"])
    perms = {"WebSearch": "always_allow"}
    allowed, disallowed = build_effective_tool_lists(session, {}, perms, False, [], [])
    assert "WebSearch" in allowed  # native path kept when we didn't register the web MCP
