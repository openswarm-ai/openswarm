"""A session socket that connects mid-reply gets the text so far, once, and nothing when there is none."""

import pathlib

from backend.apps.agents.core.stream_snapshot import stream_snapshot_payload
from backend.apps.agents.manager.streaming.PartialReply import PartialReply


def test_mid_reply_connect_gets_the_accumulated_text():
    live = {"s1": PartialReply(msg_id="m1", text="The Eiffel Tower is a wrought-iron", branch_id="main")}
    assert stream_snapshot_payload("s1", live) == {
        "session_id": "s1", "message_id": "m1", "role": "assistant", "text": "The Eiffel Tower is a wrought-iron",
    }


def test_no_reply_in_flight_means_no_snapshot():
    assert stream_snapshot_payload("s1", {}) is None
    assert stream_snapshot_payload("s1", {"s1": PartialReply(msg_id="m1", text="", branch_id="main")}) is None
    assert stream_snapshot_payload("s1", {"other": PartialReply(msg_id="m1", text="x", branch_id="main")}) is None


def test_the_snapshot_is_sent_after_the_hello_ack_not_before():
    """The client drops every stream frame that arrives before its resume ack, so a snapshot sent
    earlier would be dropped exactly like the replayed deltas it exists to replace."""
    src = pathlib.Path("backend/main.py").read_text()
    hello = src.index('"event": "server:hello"')
    snapshot = src.index('"event": "agent:stream_snapshot"')
    assert hello < snapshot
    handler = src[src.index('if event == "client:hello":'):src.index('elif event == "client:ping":')]
    assert "stream_snapshot_payload(session_id, p_am.live_partial)" in handler
