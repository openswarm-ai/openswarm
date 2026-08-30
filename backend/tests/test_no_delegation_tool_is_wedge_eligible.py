"""Every tool that hands work to a browser, an app, or another agent must be exempt from the
quick-tool wedge deadline. This is the test that was missing.

`BrowserAgents` (the PARALLEL browser tool) was registered as a real tool and left out of the
exemption set, so the quick-tool watchdog armed on it. The kill is not at 25s -- a fresh heartbeat
extends to 120s then 300s -- but `wedge_verdict` kills unconditionally at the 300s ceiling and
immediately on a stale heartbeat, so every parallel browser run past five minutes was terminated.
The singular `BrowserAgent` was exempt, so anyone testing one browser at a time saw nothing, while
the one person running several reported "browser use disconnects constantly" at an almost 100%
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
            f"{t} is registered but not exempt: a run using it dies at the 300s wedge ceiling"


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


def test_the_ceiling_is_what_kills_a_watched_browser_run_not_the_25s_check():
    """Pin the actual mechanism, because the first write-up of this bug said '25s' and was wrong.

    A fresh heartbeat extends 25 -> 120 -> 300. The kill comes from the hard ceiling, or from a stale
    heartbeat at any check. Getting this right matters: 'dies at 25s' would have sent someone hunting
    a fast-timeout bug that does not exist."""
    from backend.apps.agents.manager.streaming.unwedge_sidecar import (
        HARD_WEDGE_SECONDS, HEARTBEAT_FRESH_S, wedge_verdict,
    )
    assert wedge_verdict(30.0, 1.0) == "extend", "a slow but alive call is not wedged at 25s"
    assert wedge_verdict(200.0, 1.0) == "extend"
    assert wedge_verdict(HARD_WEDGE_SECONDS, 1.0) == "kill", "the ceiling kills regardless"
    assert wedge_verdict(30.0, HEARTBEAT_FRESH_S + 1) == "kill", "a stale heartbeat kills early"
