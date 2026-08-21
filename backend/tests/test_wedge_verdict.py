"""Pins the ENG-353 two-stage wedge contract: a fresh heartbeat (alive sidecar, slow tool) must not
be shot at the first deadline; a stale one must; nothing survives the late deadline. Five healthy
kills in one loaded evening were every one of the "MCP disconnected" reports."""
import os
import tempfile
from backend.apps.agents.manager.streaming.unwedge_sidecar import (
    HARD_WEDGE_SECONDS,
    HEARTBEAT_FRESH_S,
    LATE_WEDGE_SECONDS,
    WEDGE_SECONDS,
    heartbeat_age,
    wedge_verdict,
)


def test_stale_heartbeat_kills_at_first_deadline():
    assert wedge_verdict(WEDGE_SECONDS + 1, HEARTBEAT_FRESH_S + 1) == "kill"


def test_fresh_heartbeat_extends_instead_of_killing():
    assert wedge_verdict(WEDGE_SECONDS + 1, 2.0) == "extend"


def test_late_deadline_with_fresh_heartbeat_extends_to_the_hard_ceiling():
    # ENG-368: an alive sidecar mid-way through a long call is not wedged; only the hard ceiling ends it.
    assert wedge_verdict(LATE_WEDGE_SECONDS + 1, 0.5) == "extend"
    assert wedge_verdict(LATE_WEDGE_SECONDS + 1, HEARTBEAT_FRESH_S + 1) == "kill"
    assert wedge_verdict(HARD_WEDGE_SECONDS + 1, 0.5) == "kill"
    assert HARD_WEDGE_SECONDS > LATE_WEDGE_SECONDS > WEDGE_SECONDS


def test_missing_heartbeat_reads_as_wedged():
    assert heartbeat_age("no-such-session-anywhere") > 1e8


def test_real_heartbeat_file_reads_fresh():
    sid = "wedge-verdict-test"
    path = os.path.join(tempfile.gettempdir(), f"osw-mcp-hb-{sid}")
    with open(path, "a"):
        os.utime(path, None)
    try:
        assert heartbeat_age(sid) < 5.0
        assert wedge_verdict(WEDGE_SECONDS + 1, heartbeat_age(sid)) == "extend"
    finally:
        os.unlink(path)


def test_negative_control_old_behavior_without_heartbeat():
    age = heartbeat_age("no-such-session-anywhere")
    assert wedge_verdict(WEDGE_SECONDS + 1, age) == "kill"
