"""Why browser-use "just isn't working": three bugs read out of Eric's real chats on 2026-08-20.

Every test here is shaped by something observed live, never invented. The wire capture and the
transcripts are in QA_LEDGER.md under the same date.
"""

from backend.apps.agents.browser.browser_loop import completion_is_honest, outcome_facts


# --- ENG-372: prestage's seeded reads must not vouch for a child that never acted -----------------

SEEDED = [
    {"tool": "BrowserListInteractives", "input": {}, "ok": True, "result_summary": "[1]<link>", "elapsed_ms": 0, "seeded": True},
    {"tool": "BrowserGetText", "input": {}, "ok": True, "result_summary": "headphones $20", "elapsed_ms": 0, "seeded": True},
]


def test_seeded_reads_alone_are_a_ghost():
    """The exact action_log every dead child handed its parent: two 0ms prestage reads, nothing
    else. It was judged honest and reported as "Task completed". It is a ghost."""
    honest, why = completion_is_honest(list(SEEDED), summary="")
    assert honest is False
    assert "only looked around" in why or "single action" in why


def test_seeded_reads_plus_a_real_answer_are_honest():
    """The legitimate case (test_read_answered_from_frontloaded_perception_is_not_a_ghost): a read
    task answered straight from the prestaged page, zero further tools. Real work, not a ghost."""
    honest, _ = completion_is_honest(list(SEEDED), summary="The first sentence is: Alan Turing was a mathematician.")
    assert honest is True


def test_a_real_read_after_the_seeds_still_counts():
    """NEGATIVE CONTROL. A read-only task the agent actually performed must stay honest; the tag
    must only strip prestage's bookkeeping, never the agent's own reads."""
    log = list(SEEDED) + [{"tool": "BrowserGetText", "input": {}, "ok": True,
                           "result_summary": "Sony WH-1000XM5 $248 at Best Buy", "elapsed_ms": 412}]
    honest, _ = completion_is_honest(log)
    assert honest is True


def test_a_real_action_after_the_seeds_still_counts():
    log = list(SEEDED) + [{"tool": "BrowserClickIndex", "input": {"index": 12}, "ok": True,
                           "result_summary": "clicked", "elapsed_ms": 380}]
    honest, _ = completion_is_honest(log)
    assert honest is True


def test_outcome_facts_are_unchanged_by_the_tag():
    """The counts the parent reads beside the prose must not silently change shape."""
    facts = outcome_facts(list(SEEDED))
    assert set(facts) == {"calls", "mutations_attempted", "mutations_succeeded", "reads_with_content"}
    assert facts["calls"] == 2
