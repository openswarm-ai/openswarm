"""A send may only claim success on evidence the SYSTEM holds, never on the model's say-so.

Measured live on X, 2026-07-28, at the defaults being considered for the flip: the agent replied
"All set, your message went through and it's showing in the conversation now" and a read-only check
of the real profile proved nothing had been posted. The log showed exactly why:

    [browser-sendscript] fill target 'Post text' [52]
    [browser-sendscript] done sent_receipt=False delivered=None
    [browser-autosend] post-fill send click ran, receipt unverified; model verifies

`send_confirmed` was carrying two unrelated facts: "the click ran, so never fire another" and "it
landed, so we may say so". The stall backstop read the first and printed a sentence that only the
second could justify. This is the worst failure this agent has, because a user who is told it posted
stops checking.
"""
import inspect
import re

from backend.apps.agents.browser import browser_agent as ba
from backend.apps.agents.browser import browser_delivery_check as dc

P_SRC = inspect.getsource(ba.run_browser_agent) if hasattr(ba, "run_browser_agent") else \
    open(ba.__file__, encoding="utf-8").read()
CONFIDENT = "All set, your message went through"


def test_the_hardcoded_confident_sentence_no_longer_exists_anywhere():
    """The literal claim that shipped the lie is gone, and nothing may reintroduce it. Completion
    wording is composed by the model from what actually happened; a stock success sentence sitting
    in the source is a claim that gets made whether or not it is true."""
    assert CONFIDENT not in P_SRC, (
        "the stock success sentence is back in the source; completions must be composed from "
        "evidence, not printed from a template")


def test_the_stall_backstop_branches_on_evidence():
    """Where the lie was emitted. That backstop fires on a spinning run, so it decides the user's
    final sentence without the model ever getting to speak; it must therefore read the evidence
    flag, not the resend guard."""
    idx = P_SRC.index("done_success = delivery_verified")
    # Bounded by the next sibling branch, not by a character count. The count was 900, and adding an
    # `if p_task_is_removal:` branch (a delete must not borrow the send wording) pushed the honest
    # line past it, failing a test whose subject had not changed.
    window = P_SRC[idx:P_SRC.index("if not wrapup_nudged", idx)]
    assert "compose_unverified_send" in window, \
        "the unverified branch must compose an honest line, not fall straight to a template"
    assert "unverified_send_note" in window, \
        "and it needs a never-fails honest fallback for when the aux is unavailable"


def test_the_two_facts_are_not_the_same_variable():
    """send_confirmed exists to stop a SECOND send. Reusing it as permission to claim success is
    what made the wrong state representable, so they must stay distinct."""
    assert "delivery_verified = False" in P_SRC, "the evidence flag is gone"
    assert re.search(r"done_success = delivery_verified", P_SRC), \
        "the run's success must be a function of evidence, not of the model's Done argument"


def test_the_caller_cannot_starve_the_send_script():
    """INVARIANT, and the third time this exact trap has bitten (find_composer, import_session, now
    this). The send-script's cost and its caller's timeout drifted apart when find_composer went
    15s -> 30s: one finder call could eat the caller's whole 30s budget, so the script was killed
    mid-send and EVERY write silently fell back to the slow model loop. It was invisible because
    asyncio.TimeoutError stringifies to nothing, so the log read "outer skip ()".

    Measured live on LinkedIn: a 190.9s write that never posted."""
    from backend.apps.agents.browser import browser_send_script as ss
    from backend.apps.agents.core.ws_manager import BROWSER_CMD_TIMEOUTS

    assert "timeout=browser_send_script.WORST_CASE_BUDGET_S" in P_SRC, (
        "the caller hardcodes its own timeout again; it must import the script's stated worst case "
        "so the two cannot drift")
    # A single finder call must not be able to consume the whole budget.
    assert ss.WORST_CASE_BUDGET_S > BROWSER_CMD_TIMEOUTS.get("find_composer", 15.0) * 2, \
        "the budget must leave room for fill and submit after the finder, not just the finder"


def test_a_starved_send_is_logged_by_exception_class():
    """A bare TimeoutError has an empty message, so a starved send read exactly like a page we
    deliberately declined to touch. The class name is what makes those two distinguishable."""
    assert "type(p_se).__name__" in P_SRC


def test_an_unverified_send_gets_an_honest_line_that_does_not_claim_delivery():
    note = dc.unverified_send_note("https://x.com/home", "hello from my automation")
    low = note.lower()
    assert "could not confirm" in low or "not confirm" in low
    assert "went through and it's showing" not in low
    assert "hello from my automation" in note, "the user needs to know WHICH message is in doubt"


def test_the_honest_line_tells_the_user_to_check_and_says_it_did_not_retry():
    """Two things the user needs and cannot get anywhere else: that they must verify by hand, and
    that we did NOT blindly retry, because a silent retry is how you post twice."""
    note = dc.unverified_send_note("https://www.reddit.com/", "x" * 200).lower()
    assert "check" in note
    assert "twice" in note or "again" in note


def test_the_unverified_line_claims_strictly_less_than_the_ghost_drop_line():
    """These are different evidence states and must not collapse into one message: the ghost-drop
    note knows the composer cleared (so it WAS submitted); the unverified note knows only that a
    click ran. Saying 'the composer cleared' when it did not is a small lie inside an honest one."""
    unverified = dc.unverified_send_note("https://x.com/", "payload")
    ghost = dc.unconfirmed_delivery_note("https://x.com/", "payload")
    assert "composer cleared" in ghost
    assert "composer never cleared" in unverified
    assert unverified != ghost


def test_the_host_is_named_so_the_user_knows_where_to_look():
    assert "x.com" in dc.unverified_send_note("https://www.x.com/compose", "p")
    assert "the site" in dc.unverified_send_note("", "p")
