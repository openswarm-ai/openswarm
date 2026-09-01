"""A delegated run must not be killed by a deadline meant for a millisecond tool.

Field, 2026-09-01: browser runs on a HEALTHY, heartbeating sidecar were killed at 450s and 600s
outstanding, each ending the turn mute in front of the user. The exemption for delegated tools was
real but only governed the 25s arming; `wedge_verdict` never received the tool name, so the single
300s ceiling killed them anyway. That is a deadline on the wrong unit of work: a quick tool answers
in milliseconds, a delegated run takes as long as the browser it handed off to.

The protection that actually matters is untouched: a stale heartbeat is a wedged PROCESS and still
dies in seconds, at any age. This ceiling is only the backstop for "alive but never returns".
"""
import pytest

from backend.apps.agents.manager.streaming.unwedge_sidecar import (
    DELEGATED_HARD_WEDGE_SECONDS, HARD_WEDGE_SECONDS, HEARTBEAT_FRESH_S,
    hard_ceiling_for, wedge_verdict,
)

BROWSER = "mcp__openswarm-core__BrowserAgent"
CREATE = "mcp__openswarm-core__CreateBrowserAgent"
QUICK = "mcp__openswarm-core__MemoryWrite"


@pytest.mark.parametrize("outstanding", [450.0, 600.0])
def test_the_two_kills_from_the_field_now_survive(outstanding):
    assert wedge_verdict(outstanding, 1.0, BROWSER) == "extend"


def test_a_quick_tool_keeps_the_old_ceiling_exactly():
    assert hard_ceiling_for(QUICK) == HARD_WEDGE_SECONDS
    assert wedge_verdict(HARD_WEDGE_SECONDS, 1.0, QUICK) == "kill"


def test_delegated_tools_get_the_longer_one():
    for t in (BROWSER, CREATE, "mcp__openswarm-core__AppAgent", "mcp__openswarm-core__BrowserAgents"):
        assert hard_ceiling_for(t) == DELEGATED_HARD_WEDGE_SECONDS, t


def test_a_dead_sidecar_still_dies_in_seconds_even_for_a_delegated_tool():
    """The half that keeps this safe: a stale heartbeat means the PROCESS is gone, and no exemption
    may protect that. Without this the change would trade a false kill for a real hang."""
    assert wedge_verdict(30.0, HEARTBEAT_FRESH_S + 1, BROWSER) == "kill"
    assert wedge_verdict(1.0, 999.0, BROWSER) == "kill"


def test_a_delegated_run_is_still_bounded_eventually():
    """Not unbounded: a hung call must not hang the session forever, it just gets measured in the
    delegated run's own units."""
    assert wedge_verdict(DELEGATED_HARD_WEDGE_SECONDS, 1.0, BROWSER) == "kill"
    assert DELEGATED_HARD_WEDGE_SECONDS > HARD_WEDGE_SECONDS


def test_only_a_DECLARED_delegation_tool_earns_the_longer_ceiling():
    """Fail safe toward today's behaviour: an unknown name, an empty one, or a non-core tool keeps
    the strict 300s, so a caller that forgets to pass the name cannot silently buy 30 minutes.

    The protection against the BrowserAgents-class bug (a real delegation tool left out of the
    exemption and killed at the ceiling) is NOT a lenient default, it is the single shared list."""
    assert hard_ceiling_for("mcp__openswarm-core__SomethingAddedLater") == HARD_WEDGE_SECONDS
    assert hard_ceiling_for("") == HARD_WEDGE_SECONDS
    assert hard_ceiling_for("Bash") == HARD_WEDGE_SECONDS


def test_the_exemption_list_is_the_one_shared_list_not_a_second_copy():
    """Two lists of names that must agree will not; that drift is what cost weeks of browser runs."""
    from backend.apps.agents.manager.streaming import unwedge_sidecar as mod
    from backend.apps.agents.manager.delegation_tool_names import BLOCKING_TOOLS
    assert mod.P_BLOCKING_TOOLS is BLOCKING_TOOLS, "it must be imported, never restated"
    for t in ("BrowserAgent", "BrowserAgents", "CreateBrowserAgent", "AppAgent"):
        assert t in BLOCKING_TOOLS


def test_the_call_site_passes_the_tool_name():
    """The whole bug was that it did not. A test on wedge_verdict alone would still pass."""
    import inspect
    from backend.apps.agents.manager.streaming import unwedge_sidecar as mod
    src = inspect.getsource(mod)
    assert "wedge_verdict(outstanding, heartbeat_age(session_id), tool_name)" in src
