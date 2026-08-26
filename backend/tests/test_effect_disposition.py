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


# ---------------------------------------------- the READ side of the same problem (ENG-404)

def test_a_run_whose_every_read_failed_says_its_specifics_are_unverified():
    from backend.apps.agents.browser.effect_disposition import unverified_reads_line
    # Haik's playlist run: the clicks reported ok, every read failed, and the agent handed the user
    # "6 confirmed tracks" with titles and artists. The gate's "only looked around" check never
    # fires once an action succeeds, so nothing caught it.
    log = [{"tool": "BrowserClick", "ok": True},
           {"tool": "BrowserGetText", "ok": False},
           {"tool": "BrowserGetElements", "ok": False}]
    line = unverified_reads_line(log)
    assert "unverified" in line and "must not be treated as confirmed" in line


def test_a_read_that_returned_nothing_counts_as_failed():
    from backend.apps.agents.browser.effect_disposition import unverified_reads_line
    assert unverified_reads_line([{"tool": "BrowserGetText", "ok": True, "result_summary": "   "}])


def test_a_run_that_really_read_the_page_is_left_alone():
    from backend.apps.agents.browser.effect_disposition import unverified_reads_line
    assert unverified_reads_line(
        [{"tool": "BrowserGetText", "ok": True, "result_summary": "Track 1 - Artist"}]) == ""


def test_a_pure_write_run_is_not_labelled():
    # It never tried to read, so there is nothing unverified to warn about; a note on every write
    # would be noise, and noise is how a real warning stops being read.
    from backend.apps.agents.browser.effect_disposition import unverified_reads_line
    assert unverified_reads_line([{"tool": "BrowserType", "ok": True}]) == ""
    assert unverified_reads_line([]) == ""


def test_the_label_rides_the_SUCCESSFUL_path_where_the_fabrication_travelled():
    src = open("backend/apps/agents/browser/browser_agent.py").read()
    i_ghost = src.index("completion gate caught a ghost")
    i_label = src.index("unverified_reads_line(action_log)")
    assert i_label > i_ghost, "it belongs on the else branch: the run the gate let through"
    assert "summary = f\"{summary}\\n\\n{p_unverified}\"" in src


def test_it_labels_rather_than_rejects():
    # A click that lands while the verification read fails is an honest partial. Flipping that to an
    # error would delete real work to punish a word.
    src = open("backend/apps/agents/browser/browser_agent.py").read()
    i = src.index("unverified_reads_line(action_log)")
    # Up to (not including) the status assignment that closes the branch: nothing in here may
    # change the verdict, only the text.
    body = src[i:src.index("session.status = final_status", i)]
    assert "final_status =" not in body and "honest = False" not in body
    assert "summary = " in body, "the only thing it touches is the wording"
