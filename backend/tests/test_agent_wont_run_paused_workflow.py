"""An agent must not start a workflow the user switched off.

Field report (Haik, 1.7.4): "a workflow that had been toggled off just started running again".
The route ignores `schedule.enabled` for manual runs on purpose, because a human clicking Run Now
can see the paused state. An agent reaching that same route is a different act.
"""

from unittest.mock import patch

import backend.apps.agents.schedule_mcp_server as mod


def p_calls(get_result):
    seen = {"ran": False}
    def fake(method, path, body=None, timeout=None):
        if method == "GET":
            return get_result
        seen["ran"] = True
        return {"run_id": "r1"}
    return fake, seen


def test_agent_refuses_to_run_a_paused_workflow():
    fake, seen = p_calls({"title": "Nightly report", "schedule": {"enabled": False}})
    with patch.object(mod, "_call", side_effect=fake):
        out = mod.handle_run_now({"workflow_id": "w1"})
    assert seen["ran"] is False, "the run must never be dispatched"
    assert out.get("isError") is True
    text = out["content"][0]["text"]
    assert "paused" in text and "Nightly report" in text


def test_agent_runs_an_enabled_workflow_normally():
    fake, seen = p_calls({"title": "Nightly report", "schedule": {"enabled": True}})
    with patch.object(mod, "_call", side_effect=fake):
        out = mod.handle_run_now({"workflow_id": "w1"})
    assert seen["ran"] is True
    assert not out.get("isError")


def test_an_unreadable_workflow_does_not_block_the_run():
    """Fail open: if we cannot read the workflow, behave as before rather than refusing everything."""
    fake, seen = p_calls({"_error": "boom"})
    with patch.object(mod, "_call", side_effect=fake):
        out = mod.handle_run_now({"workflow_id": "w1"})
    assert seen["ran"] is True
    assert not out.get("isError")
