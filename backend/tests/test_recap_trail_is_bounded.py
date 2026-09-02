"""The recap's tool trail must be bounded whatever the chat's length.

Aging kept one line per tool call forever. Eric's real Recall Radar chat (766 tool calls) rebuilt
with a 311,990-char / 97,923-token recap, so its first request was 192,056 tokens against a 180,000
trigger: the CLI compacted before the second tool call, the window refilled, and the chat died of
"Autocompact is thrashing" five times on exp.5 and again, identically, on exp.3 (2026-09-01)."""
from backend.apps.agents.core.models import Message
from backend.apps.agents.manager.session.history_compaction import (
    RECAP_STUB_MAX_CHARS, RECAP_TRAIL_MAX_CHARS, bound_trail, build_history_prefix, trail_lines,
)


def p_long_chat(calls: int):
    msgs = [Message(role="user", content="Build the recall app, for real.", branch_id="main")]
    for i in range(calls):
        tool = "Bash" if i % 3 else "Read"
        msgs.append(Message(role="tool_call", content={"tool": tool, "input": {"command": f"step {i} " + "x" * 120}}, branch_id="main"))
        msgs.append(Message(role="tool_result", content={"tool_name": tool, "text": f"result {i} " + "y" * 300}, branch_id="main"))
        if i % 100 == 99:
            msgs.append(Message(role="user", content=f"checkpoint ask {i}", branch_id="main"))
    msgs.append(Message(role="user", content="what's the progress?", branch_id="main"))
    return msgs


def test_an_800_call_chat_rebuilds_under_the_budget_and_says_what_it_dropped():
    lines = trail_lines(p_long_chat(800))
    p_tool = [l for l in lines if l.startswith("Tool ")]
    assert sum(len(l) + 1 for l in p_tool) <= RECAP_TRAIL_MAX_CHARS + RECAP_STUB_MAX_CHARS, "full tier plus stub tier is the whole tool budget"
    p_fold = [l for l in lines if "earlier tool calls are not shown" in l]
    assert len(p_fold) == 1, "exactly one counted fold line"
    assert "Bash" in p_fold[0] and "Read" in p_fold[0], "the fold names what it dropped, by tool"
    assert lines.index(p_fold[0]) < lines.index(p_tool[0]), "the fold sits where the dropped span was, before the kept tail"


def test_every_ask_survives_and_the_newest_calls_stay_verbatim():
    msgs = p_long_chat(800)
    lines = trail_lines(msgs)
    asks = [l for l in lines if l.startswith("The user asked")]
    assert len(asks) == 1 + 8 + 1, "no ask is ever folded"
    assert any("step 799 " in l for l in lines), "the newest call is verbatim"
    assert any("result 799 " in l for l in lines), "the newest result is verbatim"
    assert not any("step 5 " in l for l in lines), "the oldest call is folded away"


def test_a_short_chat_is_untouched():
    msgs = p_long_chat(20)
    lines = trail_lines(msgs)
    assert not any("not shown" in l for l in lines)
    assert sum(1 for l in lines if l.startswith("Tool call")) == 20


def test_the_whole_prefix_is_bounded_for_the_real_shape():
    out = build_history_prefix(p_long_chat(766))
    assert len(out) < RECAP_TRAIL_MAX_CHARS + RECAP_STUB_MAX_CHARS + 8_000, f"prefix is {len(out)} chars; the frame plus a bounded trail"


def test_the_middle_tier_keeps_bare_rerunnable_stubs_and_no_result_lines():
    lines = trail_lines(p_long_chat(800))
    p_first_full = next(i for i, l in enumerate(lines) if l.startswith("Tool result"))
    p_stubs = [l for l in lines[:p_first_full] if l.startswith("Tool call")]
    assert p_stubs, "an 800-call chat has a middle tier of bare stubs"
    assert all(len(l) <= 120 for l in p_stubs)
    assert not any(l.startswith("Tool result") for l in lines[:p_first_full])


def test_bound_trail_is_a_no_op_under_budget():
    lines = ["The user asked: a", "Tool call: Read(x)", "Tool result (Read): ok"]
    assert bound_trail(lines, 10_000) == lines
