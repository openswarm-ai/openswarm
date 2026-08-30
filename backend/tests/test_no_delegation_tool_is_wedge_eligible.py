"""Every tool that hands work to a browser, an app, or another agent must be exempt from the
quick-tool wedge deadline. This is the test that was missing.

`BrowserAgents` (the PARALLEL browser tool) was registered as a real tool and left out of the
exemption set, so the 25s quick-tool watchdog shot the sidecar 25 seconds into every parallel browser
run. The singular `BrowserAgent` was exempt, so anyone testing one browser at a time saw nothing,
while the one person running several reported "browser use disconnects constantly" at an almost 100%
failure rate for weeks.

The defect is the repo's signature shape: two lists of names that must agree, with nothing checking
them against each other (same as .gitignore vs build.files). There is one list now, and this test is
what keeps it that way."""

from backend.apps.agents.core.models import AgentSession
from backend.apps.agents.manager.delegation_tool_names import (
    BLOCKING_TOOLS, BROWSER_DELEGATION_TOOLS,
)
from backend.apps.agents.manager.register_builtin_mcp_servers import register_builtin_mcp_servers
from backend.apps.agents.manager.streaming.unwedge_sidecar import CORE_PREFIX, is_quick_core_tool


def test_every_registered_browser_tool_is_wedge_exempt():
    """Asserted against what the app REGISTERS, not against a copy of the list, so adding a tool to
    the registry without exempting it fails here instead of in a user's browser run."""
    servers = {}
    browser_tools, _ = register_builtin_mcp_servers(servers, AgentSession(name="t"), {}, None, None)
    assert browser_tools, "the registry stopped returning browser tools"
    for t in browser_tools:
        assert not is_quick_core_tool(CORE_PREFIX + t), \
            f"{t} is registered but not exempt: a run using it dies at the 25s quick-tool deadline"


def test_the_parallel_form_specifically(_=None):
    """Named on its own because it is the one that was missing, and because a plural/singular pair is
    exactly the kind of near-duplicate a reader's eye slides over."""
    for t in ("BrowserAgent", "BrowserAgents"):
        assert not is_quick_core_tool(CORE_PREFIX + t), f"{t} must never be treated as a quick tool"


def test_the_two_lists_cannot_drift_because_there_is_only_one():
    src = open("backend/apps/agents/manager/streaming/unwedge_sidecar.py", encoding="utf-8").read()
    assert "delegation_tool_names import" in src, "the watchdog must import the names, not restate them"
    assert '"BrowserAgent"' not in src, "a second hand-written copy is how this bug happened"
    reg = open("backend/apps/agents/manager/register_builtin_mcp_servers.py", encoding="utf-8").read()
    assert "BROWSER_DELEGATION_TOOLS" in reg, "the registry must read the same list"


def test_an_ordinary_quick_tool_is_still_watched():
    """The innocent case. Exempting everything would delete the guard: a genuinely wedged sidecar on
    a millisecond tool is what the 25s deadline exists for."""
    for t in ("MemoryRead", "SettingsRead", "ListScheduledWorkflows"):
        assert is_quick_core_tool(CORE_PREFIX + t), f"{t} should still be watched"
    assert set(BROWSER_DELEGATION_TOOLS) <= BLOCKING_TOOLS
