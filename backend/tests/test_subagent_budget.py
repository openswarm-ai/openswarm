"""A delegated child gets a budget it can see, and running out is not a crash.

Live on production 1.7.9, 2026-08-26: a ten-page transcription child burned 37 productive steps
(26 reads + 11 commands) and died at the wall having written nothing, with
`error_max_turns. Reached maximum number of turns (25)` as the whole explanation. Sibling agents
that finished their file left usable output on disk; this one's work was simply gone (ENG-409).
"""

from backend.apps.agents.manager.subagent_budget import (
    SUBAGENT_MAX_TURNS, budget_briefing, out_of_turns_message, subagent_turn_budget,
)

LAUNCH = "backend/apps/agents/manager/AgentLaunch.py"
SPAWN = "backend/apps/agents/manager/SpawnAgentRun.py"
RESULT = "backend/apps/agents/manager/streaming/handle_result_message.py"


def test_the_cap_has_exactly_one_definition():
    # It was a bare `or 25` in two unrelated files, so raising it in one left the other behind.
    for path in (LAUNCH, SPAWN):
        src = open(path).read()
        assert "or 25," not in src, f"{path} still carries its own copy of the cap"
        assert "subagent_turn_budget(" in src


def test_a_parent_budget_is_inherited_and_only_then_defaulted():
    assert subagent_turn_budget(60) == 60, "an explicit budget must win"
    assert subagent_turn_budget(None) == SUBAGENT_MAX_TURNS
    assert subagent_turn_budget(0) == SUBAGENT_MAX_TURNS, "0 is not a budget"


def test_the_briefing_tells_the_child_to_checkpoint():
    b = budget_briefing(25)
    assert "25" in b
    assert "save partial results" in b, "the whole point is that it writes before the wall"


def test_the_briefing_never_names_the_harness():
    # Same rule as every other injected string: on a lane whose terms restrict third-party automated
    # use, describing the machinery is a liability (CLAUDE.md, "never announce automation").
    b = budget_briefing(25).lower()
    for word in ("openswarm", "harness", "sub-agent", "subagent", "orchestrat"):
        assert word not in b, f"the briefing must not mention {word}"


def test_running_out_reads_as_a_budget_not_a_crash():
    m = out_of_turns_message(25)
    assert "25" in m
    assert "on disk" in m, "the user has to know partial work survived"
    assert "carry on" in m
    assert "error" not in m.lower() and "failed" not in m.lower()


def test_the_result_handler_uses_it_instead_of_the_runtime_string():
    src = open(RESULT).read()
    i_branch = src.index('error_max_turns')
    i_generic = src.index('"The agent runtime reported this turn failed"')
    assert i_branch < i_generic, "the budget case must be caught before the generic failure text"
    assert "out_of_turns_message" in src


def test_the_child_is_actually_told_its_budget():
    # A briefing nothing sends is the row-6 shape: present, reachable, doing nothing.
    src = open(SPAWN).read()
    assert "budget_briefing(" in src, "the child must receive the briefing, not just have one available"
    i_brief = src.index("budget_briefing(")
    i_run = src.index("run_agent_loop(child.id, p_sent)")
    assert i_brief < i_run


def test_the_briefing_does_not_pollute_the_visible_task():
    # The card should show what the parent asked for; bookkeeping rides on the sent prompt only.
    src = open(SPAWN).read()
    i_msg = src.index("content=prompt,")
    i_sent = src.index("p_sent = f\"{prompt}")
    assert i_msg < i_sent, "the stored user message must be built from the clean prompt"
