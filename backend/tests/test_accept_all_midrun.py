"""'Approve All' mid-run invariant: an allow carrying set_always_allow must make the
NEXT identical tool call auto-approve inside the SAME run. The gate reads the live
builtin_perms dict (effective_policy) and the approval path writes through the same
dict (set_tool_policy), so the policy written at approval time is visible to the very
next call without waiting for the next turn's from-disk reload. Pins the loop the
frontend 'Approve All' buttons now rely on (they send set_always_allow=true)."""

import pytest

from backend.apps.agents.manager.permissions import decision


@pytest.fixture()
def p_isolated_persistence(monkeypatch):
    """Redirect the disk-persistence half of set_tool_policy into memory."""
    persisted: dict = {"perms": {}}
    monkeypatch.setattr(decision, "load_all_tools", lambda: [])
    monkeypatch.setattr(decision, "load_builtin_permissions", lambda: dict(persisted["perms"]))
    monkeypatch.setattr(decision, "save_builtin_permissions", lambda perms: persisted.update(perms=dict(perms)))
    return persisted


def test_always_allow_applies_to_next_call_same_run(p_isolated_persistence):
    live_perms = {"Bash": "ask"}
    assert decision.effective_policy("Bash", live_perms, {}) == "ask"
    decision.set_tool_policy("Bash", "always_allow", live_perms)
    # The very next identical call in the SAME run reads the live dict and auto-approves.
    assert decision.effective_policy("Bash", live_perms, {}) == "always_allow"
    # And it persisted, so the next turn's from-disk reload keeps it.
    assert p_isolated_persistence["perms"]["Bash"] == "always_allow"


def test_always_allow_namespaced_builtin_uses_inner_slot(p_isolated_persistence):
    # Our browser/invoke delegation tools live in builtin_permissions under the INNER name; a write through the namespaced name must land where the next read looks.
    live_perms: dict = {}
    name = "mcp__openswarm-browser-agent__BrowserAgent"
    decision.set_tool_policy(name, "always_allow", live_perms)
    assert live_perms == {"BrowserAgent": "always_allow"}
    assert decision.effective_policy(name, live_perms, {}) == "always_allow"


def test_plain_allow_leaves_policy_untouched(p_isolated_persistence):
    # A one-time allow (no set_always_allow) never calls set_tool_policy; the policy stays 'ask' and the next call prompts again. Guards against silently widening plain approves.
    live_perms = {"Bash": "ask"}
    assert decision.effective_policy("Bash", live_perms, {}) == "ask"
    assert p_isolated_persistence["perms"] == {}
