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
    assert "stream_snapshot_payload(session_id, p_am.live_partial, p_am.live_thinking, in_flight=p_in_flight)" in handler


def test_a_socket_that_connects_mid_thought_gets_the_thinking_so_far_and_the_answer_wins_once_it_flows():
    thinking = {"s1": PartialReply(msg_id="t1", text="Considering the four legs", branch_id="main")}
    assert stream_snapshot_payload("s1", {}, thinking) == {"session_id": "s1", "message_id": "t1", "role": "thinking", "text": "Considering the four legs"}
    text = {"s1": PartialReply(msg_id="m1", text="The Eiffel", branch_id="main")}
    assert stream_snapshot_payload("s1", text, thinking)["role"] == "assistant"


def test_a_finished_turn_never_snapshots_even_if_a_dict_still_holds_text():
    """Eric, 2026-09-03, on the packaged exp.4: every card opened after a Haiku reply showed a "still
    thinking" bubble with a caret, because the thinking text was never dropped and the snapshot had no
    notion of whether the turn was over. The door refuses first; the leak is sealed separately."""
    thinking = {"s1": PartialReply(msg_id="t1", text="leftover thought", branch_id="main")}
    text = {"s1": PartialReply(msg_id="m1", text="leftover reply", branch_id="main")}
    assert stream_snapshot_payload("s1", text, thinking, in_flight=False) is None
    assert stream_snapshot_payload("s1", text, thinking, in_flight=True) is not None


def test_the_thought_is_dropped_when_the_answer_starts_even_without_a_block_stop():
    import asyncio
    from claude_agent_sdk.types import StreamEvent
    from backend.apps.agents.core.models import AgentSession
    from backend.apps.agents.manager.streaming import handle_stream_event as mod
    from backend.apps.agents.manager.streaming.state import ThinkingState, TurnState

    class P_WS:
        async def send_to_session(self, sid, event, data):
            return None

    def ev(payload):
        return StreamEvent(uuid="u", session_id="s1", event=payload, parent_tool_use_id=None)

    session = AgentSession(name="probe", model="opus", cwd="/tmp")
    turn, thinking_state = TurnState(), ThinkingState()
    live_partial, live_thinking = {}, {}

    async def run():
        p_orig = mod.ws_manager
        mod.ws_manager = P_WS()
        try:
            await mod.handle_stream_event(ev({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}}), session, "s1", turn, thinking_state, live_partial, live_thinking)
            await mod.handle_stream_event(ev({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hmm"}}), session, "s1", turn, thinking_state, live_partial, live_thinking)
            assert "s1" in live_thinking, "the thought is live while it streams"
            # No content_block_stop for index 0 (Haiku), straight to the answer.
            await mod.handle_stream_event(ev({"type": "content_block_start", "index": 1, "content_block": {"type": "text"}}), session, "s1", turn, thinking_state, live_partial, live_thinking)
            assert "s1" not in live_thinking, "the thought must be gone once the answer begins"
            live_thinking["s1"] = PartialReply(msg_id="t9", text="late", branch_id="main")
            await mod.handle_stream_event(ev({"type": "message_stop"}), session, "s1", turn, thinking_state, live_partial, live_thinking)
            assert "s1" not in live_thinking, "message_stop drops it too"
        finally:
            mod.ws_manager = p_orig
    asyncio.run(run())


def test_every_site_that_drops_the_live_reply_drops_the_live_thought():
    import os, re
    root = os.path.join(os.path.dirname(__file__), "..", "apps", "agents")
    hits = 0
    for dirpath, _d, files in os.walk(root):
        for name in files:
            if not name.endswith(".py"):
                continue
            src = open(os.path.join(dirpath, name)).read()
            for m in re.finditer(r"live_partial\.pop\((session\.id|session_id), None\)", src):
                hits += 1
                window = src[m.end(): m.end() + 200]
                assert "live_thinking.pop(" in window, f"{name}: live_partial popped without live_thinking at offset {m.start()}"
    assert hits >= 4, f"expected the four turn-end sites, found {hits}"
