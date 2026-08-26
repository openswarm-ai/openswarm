"""A failed browser dispatch must resolve to a state the caller can branch on.

Haik, production 1.7.9, on a Spotify playlist edit: "Zero-confidence outcomes on a write path is
the worst possible spot to leave an agent in: I'm forced to choose between doing nothing and
risking a double-write." The honesty gate was right to refuse to claim the send happened. What it
returned was prose, so a parent agent could not tell "definitely did not happen" from "cannot
tell", and a naive retry duplicates tracks (ENG-402).
"""

from backend.apps.agents.browser.browser_loop import STATE_CHANGING_TOOLS, READ_ONLY_TOOLS
from backend.apps.agents.browser.effect_disposition import (
    CONFIRMED, MAY_HAVE_HAPPENED, NOTHING_HAPPENED, disposition_line, effect_disposition,
)


def p_log(*tools):
    return [{"tool": t, "ok": True} for t in tools]


def test_a_run_that_only_looked_around_changed_nothing():
    assert effect_disposition([]) == NOTHING_HAPPENED
    assert effect_disposition(p_log(*sorted(READ_ONLY_TOOLS))) == NOTHING_HAPPENED


def test_an_attempted_write_with_no_proof_is_unknown_not_failed():
    # This is the Spotify case: every click returned ok and the send was never confirmed.
    assert effect_disposition(p_log("BrowserType", "BrowserClick")) == MAY_HAVE_HAPPENED


def test_ok_on_a_click_is_not_proof_the_write_landed():
    # A click reporting success is how a user got told "Done, I sent it for you" on a post that
    # never arrived. Only the run's own confirmation signal earns "applied".
    assert effect_disposition([{"tool": "BrowserClick", "ok": True}]) != CONFIRMED
    assert effect_disposition([{"tool": "BrowserClick", "ok": True}], send_confirmed=True) == CONFIRMED


def test_an_unrecognised_tool_is_assumed_to_have_changed_something():
    # The read-only set is an ALLOWLIST. A browser tool added tomorrow must read as UNKNOWN, not as
    # harmless: ENG-297 shipped seven state-changing tools that no classifier knew about.
    assert effect_disposition(p_log("BrowserSomethingShippedNextWeek")) == MAY_HAVE_HAPPENED
    for tool in STATE_CHANGING_TOOLS:
        assert effect_disposition(p_log(tool)) == MAY_HAVE_HAPPENED, tool


def test_every_disposition_tells_the_caller_what_to_do_next():
    assert "safe to retry" in disposition_line(NOTHING_HAPPENED)
    assert "do not repeat" in disposition_line(CONFIRMED)
    unknown = disposition_line(MAY_HAVE_HAPPENED)
    assert "check before retrying" in unknown and "twice" in unknown
    assert "may or may not" in unknown, "the ambiguity has to be stated, not implied"


def test_the_failed_run_carries_the_disposition_home():
    src = open("backend/apps/agents/browser/browser_agent.py").read()
    i = src.index("I was not able to complete this task")
    body = src[i - 400:i + 300]
    assert "effect_disposition(action_log" in body
    assert "disposition_line(p_effect)" in body, "the sentence must reach the caller's summary"
