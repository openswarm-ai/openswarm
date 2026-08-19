"""Pins the hermes-aging recap contract (ENG-354 endgame): duplicates collapse, the newest
results survive verbatim, old bulk becomes a re-runnable stub, pre-cutoff history ages
instead of vanishing, and the whole recap is bounded no matter how long the session ran."""

from backend.apps.agents.core.models import AgentSession, Message
from backend.apps.agents.manager.session.aged_recap_lines import (
    DUPLICATE_LINE,
    PRUNE_MIN_CHARS,
    TAIL_BUDGET_CHARS,
    age_tool_results,
    stub_line,
)
from backend.apps.agents.manager.session.history_compaction import build_history_prefix


def p_msgs(*pairs):
    out = []
    for tool, args, result in pairs:
        out.append(Message(role="tool_call", content={"tool": tool, "input": args}))
        out.append(Message(role="tool_result", content={"text": result, "tool_name": tool}))
    return out


def test_old_bulk_ages_into_a_rerunnable_stub():
    msgs = p_msgs(*[("Read", {"file_path": f"/tmp/f{i}.txt"}, f"body{i} " + "x" * 5000) for i in range(12)])
    fates = age_tool_results(msgs)
    aged = [f for f in fates.values() if f.startswith("[Read]")]
    assert aged, "no stubs produced"
    assert any("/tmp/f0.txt" in f and "chars result)" in f for f in aged), "stub lost the re-runnable args"


def test_newest_results_survive_verbatim_within_budget():
    msgs = p_msgs(*[("Read", {"file_path": f"/f{i}"}, f"UNIQUE-{i} " + "y" * 3000) for i in range(10)])
    fates = age_tool_results(msgs)
    newest = fates[len(msgs) - 1]
    assert "UNIQUE-9" in newest and not newest.startswith("[Read]")
    total_verbatim = sum(len(f) for f in fates.values() if not f.startswith("["))
    # The count floor is hermes semantics: at least TAIL_COUNT_FLOOR survive regardless of budget, each capped at TAIL_ITEM_CAP.
    from backend.apps.agents.manager.session.aged_recap_lines import TAIL_COUNT_FLOOR, TAIL_ITEM_CAP
    assert total_verbatim <= max(TAIL_BUDGET_CHARS + TAIL_ITEM_CAP, TAIL_COUNT_FLOOR * TAIL_ITEM_CAP)
    assert len([f for f in fates.values() if not f.startswith("[")]) >= TAIL_COUNT_FLOOR


def test_duplicates_collapse_to_backreference():
    same = "identical result " + "z" * 400
    msgs = p_msgs(("Read", {"file_path": "/a"}, same), ("Read", {"file_path": "/a"}, same), ("Read", {"file_path": "/a"}, same))
    fates = age_tool_results(msgs)
    dupes = [f for f in fates.values() if f == DUPLICATE_LINE]
    assert len(dupes) == 2, "older duplicates must collapse; newest keeps the copy"


def test_small_results_always_survive_whole():
    msgs = p_msgs(*[("Bash", {"command": f"echo {i}"}, f"tiny-{i}") for i in range(30)])
    fates = age_tool_results(msgs)
    assert all(f.startswith("tiny-") for f in fates.values())


def test_precutoff_ages_instead_of_vanishing():
    s = AgentSession(name="t", model="sonnet")
    for i in range(10):
        s.messages.append(Message(role="tool_call", content={"tool": "Bash", "input": {"command": f"grep -rn pat{i} src/"}}))
        s.messages.append(Message(role="tool_result", content={"text": f"match{i} " + "m" * 3000, "tool_name": "Bash"}))
    cutoff = s.messages[9].id
    recap = build_history_prefix(s.messages, cutoff_msg_id=cutoff)
    assert "grep -rn pat1" in recap, "pre-cutoff command vanished; aging must keep the trail"
    assert "match9" in recap, "newest result must survive verbatim"
    pre = recap.split("match9")[0]
    assert "chars result)" in pre, "pre-cutoff results must be stubs, not verbatim"


def test_recap_is_bounded_for_marathon_sessions():
    s = AgentSession(name="t", model="sonnet")
    for i in range(120):
        s.messages.append(Message(role="tool_call", content={"tool": "Read", "input": {"file_path": f"/tmp/m{i}.txt"}}))
        s.messages.append(Message(role="tool_result", content={"text": f"MARA-{i} " + "w" * 8000, "tool_name": "Read"}))
    recap = build_history_prefix(s.messages)
    assert len(recap) < 80_000, f"recap unbounded: {len(recap)} chars for a 120-read session"
    assert "MARA-119" in recap
    assert "/tmp/m0.txt" in recap


def test_stub_format_matches_hermes_shape():
    line = stub_line("Bash", '{"command": "pytest -q"}', 22_770)
    assert line == '[Bash] {"command": "pytest -q"} (22,770 chars result)'


def test_below_floor_never_stubbed():
    msgs = p_msgs(("Bash", {"command": "date"}, "x" * (PRUNE_MIN_CHARS - 1)))
    fates = age_tool_results(msgs)
    assert not list(fates.values())[0].startswith("[Bash]")
