"""The connect-time half of ENG-303 (found 2026-08-14 by freezing the sidecar BEFORE the CLI
connected). The mid-call watchdog cannot see this one: nothing hangs, so no tool result is
produced and no hook fires. Every `mcp__openswarm-core__*` call returns "No such tool available"
instantly and the session is toolless for its whole life, because MCP registration happens once.

The CLI states the fact in its init message, so we read it instead of inferring it:

    mcp_servers: [{'name': 'openswarm-core', 'status': 'connected'}]

The risk to guard is the opposite direction: a false positive respawns a HEALTHY session, so
anything other than an explicit non-connected status must read as "no opinion".
"""

import inspect

from backend.apps.agents.manager.streaming.core_mcp_health import (
    core_mcp_failed_to_connect,
    core_mcp_status,
    note_core_mcp_health,
)


def p_init(servers):
    # The real shape, as logged live: subtype + a nested data dict.
    return {"subtype": "init", "data": {"type": "system", "subtype": "init", "mcp_servers": servers}}


# --------------------------------------------------------------------- reading the fact


def test_a_connected_core_server_is_not_a_failure():
    payload = p_init([{"name": "openswarm-core", "status": "connected"}])
    assert core_mcp_status(payload) == "connected"
    assert core_mcp_failed_to_connect(payload) is False


def test_an_explicitly_failed_core_server_is_caught():
    for bad in ("failed", "error", "disconnected", "pending"):
        assert core_mcp_failed_to_connect(p_init([{"name": "openswarm-core", "status": bad}])) is True, bad


def test_the_flat_shape_works_too():
    # Some payloads arrive without the nested data wrapper.
    assert core_mcp_failed_to_connect({"mcp_servers": [{"name": "openswarm-core", "status": "failed"}]}) is True


# --------------------------------------------------------------------- never invent a failure


def test_silence_is_not_failure():
    # No opinion must never respawn a healthy session.
    assert core_mcp_failed_to_connect(p_init([])) is False
    assert core_mcp_failed_to_connect({"subtype": "init", "data": {}}) is False
    assert core_mcp_failed_to_connect({}) is False
    assert core_mcp_failed_to_connect(None) is False
    assert core_mcp_failed_to_connect("not a dict at all") is False


def test_another_server_failing_says_nothing_about_ours():
    payload = p_init([{"name": "some-other-mcp", "status": "failed"}])
    assert core_mcp_status(payload) is None
    assert core_mcp_failed_to_connect(payload) is False


def test_a_malformed_entry_is_ignored_rather_than_read_as_broken():
    assert core_mcp_failed_to_connect(p_init(["not-a-dict", 7, None])) is False
    assert core_mcp_failed_to_connect(p_init([{"name": "openswarm-core"}])) is False


# --------------------------------------------------------------------- the consequence


class P_Session:
    needs_fresh_session = False


def test_a_failed_connect_arms_a_fresh_cli_session():
    s = P_Session()
    assert note_core_mcp_health(s, "sess-1", p_init([{"name": "openswarm-core", "status": "failed"}])) is True
    assert s.needs_fresh_session is True, "a toolless session stays toolless until the CLI respawns"


def test_a_healthy_connect_changes_nothing():
    s = P_Session()
    assert note_core_mcp_health(s, "sess-2", p_init([{"name": "openswarm-core", "status": "connected"}])) is False
    assert s.needs_fresh_session is False


def test_the_turn_runner_consults_this_on_init():
    from backend.apps.agents.manager.run import TurnRunner
    src = inspect.getsource(TurnRunner)
    assert "note_core_mcp_health" in src
    assert 'p_subtype == "init"' in src, "the status is only reported on the init message"
