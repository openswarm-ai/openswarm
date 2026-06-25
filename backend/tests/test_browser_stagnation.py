"""Deterministic stagnation detection for the browser sub-agent."""

from backend.apps.agents.browser.browser_loop import (
    STAGNATION_ESCALATION_AT,
    STAGNATION_MAX,
    looks_like_failure,
    advance_stagnation,
    card_is_unavailable,
    completion_is_honest,
    deliverable_is_informational,
    is_unproductive,
    stagnation_exhausted,
    stagnation_nudge,
)


def p_fail(url="https://a.com"):
    return {"text": "Element not found: '.x'", "url": url}


def test_looks_like_failure_positive():
    assert looks_like_failure("Element not found: '.foo'")
    assert looks_like_failure("Index 4 is no longer valid")
    assert looks_like_failure("Error: something broke")


def test_looks_like_failure_negative():
    assert not looks_like_failure("Clicked element: button#submit")
    assert not looks_like_failure("Typed into: input#email")


def test_error_result_is_unproductive():
    assert is_unproductive("BrowserClick", {"error": "boom"}, "", "")


def test_failure_text_is_unproductive():
    r = {"text": "Element not found: '.x'", "url": "https://a.com"}
    assert is_unproductive("BrowserClick", r, "https://a.com", "prev")


def test_url_change_is_productive():
    r = {"text": "Element not found", "url": "https://b.com"}
    # even a failure-shaped message counts as progress if the URL moved
    assert not is_unproductive("BrowserClick", r, "https://a.com", "prev")


def test_success_without_url_change_gets_benefit_of_doubt():
    r = {"text": "Clicked element: button#menu", "url": "https://a.com"}
    assert not is_unproductive("BrowserClickIndex", r, "https://a.com", "prev")


def test_identical_observation_is_unproductive():
    r = {"text": "same observation", "url": "https://a.com"}
    assert is_unproductive("BrowserScroll", r, "https://a.com", "same observation")


def test_neutral_read_tools_never_count():
    r = {"error": "whatever"}
    assert not is_unproductive("BrowserScreenshot", r, "", "")
    assert not is_unproductive("BrowserGetText", r, "", "")
    assert not is_unproductive("BrowserListInteractives", r, "", "")


def test_nudge_mentions_human_intervention_only_at_max():
    assert "RequestHumanIntervention" not in stagnation_nudge(3)
    assert "RequestHumanIntervention" in stagnation_nudge(STAGNATION_MAX)
    assert "ladder" in stagnation_nudge(3)


def test_advance_increments_on_failures_and_nudges_at_threshold():
    streak, url, text, nudge = 0, "", "", None
    nudges = []
    for _ in range(STAGNATION_ESCALATION_AT):
        streak, url, text, nudge = advance_stagnation(streak, url, text, "BrowserClick", p_fail())
        nudges.append(nudge)
    assert streak == STAGNATION_ESCALATION_AT
    assert nudges[-1] is not None  # nudge fires exactly when the threshold is hit
    assert nudges[0] is None and nudges[1] is None


def test_advance_resets_on_progress():
    # two failures, then a navigation (URL change) clears the streak
    streak, url, text, _ = advance_stagnation(0, "", "", "BrowserClick", p_fail("https://a.com"))
    streak, url, text, _ = advance_stagnation(streak, url, text, "BrowserClick", p_fail("https://a.com"))
    assert streak == 2
    streak, url, text, _ = advance_stagnation(
        streak, url, text, "BrowserNavigate", {"text": "Navigated", "url": "https://b.com"},
    )
    assert streak == 0


def test_advance_neutral_tools_pass_through_unchanged():
    streak, url, text, nudge = advance_stagnation(
        2, "https://a.com", "prev", "BrowserScreenshot", {"image": "..."},
    )
    assert (streak, url, text, nudge) == (2, "https://a.com", "prev", None)


def test_advance_fires_again_at_max():
    streak, url, text = STAGNATION_MAX - 1, "https://a.com", "prev different"
    streak, url, text, nudge = advance_stagnation(streak, url, text, "BrowserClick", p_fail())
    assert streak == STAGNATION_MAX
    assert nudge is not None and "RequestHumanIntervention" in nudge
    assert stagnation_exhausted(streak)


# --- completion honesty gate ---------------------------------------------- Catches the worst measured ghost: multi-minute runs, every tool errored, still reported 'completed'. Must NOT cry wolf on real successes (it overrides status).

def p_ok(tool, summary="done"):
    return {"tool": tool, "ok": True, "result_summary": summary}


def p_err(tool):
    return {"tool": tool, "ok": False, "result_summary": "Element not found: '.x'"}


def test_completion_honest_when_an_action_succeeded():
    log = [p_ok("BrowserListInteractives", "1 button"), p_ok("BrowserClickIndex", "Clicked")]
    honest, reason = completion_is_honest(log)
    assert honest and reason == ""


def test_completion_ghost_when_every_action_errored():
    # the exact LinkedIn ghost: 8 tools, all errored, model said 'completed'
    log = [p_err("BrowserClick") for _ in range(8)]
    honest, reason = completion_is_honest(log)
    assert not honest and "every state-changing action failed" in reason


def test_completion_ghost_when_zero_actions_taken():
    honest, reason = completion_is_honest([])
    assert not honest and "without taking a single action" in reason


def test_completion_ghost_when_only_looked_around_with_no_content():
    # screenshot returned but no text, no action -> nothing real happened
    log = [{"tool": "BrowserScreenshot", "ok": True, "result_summary": ""}]
    honest, reason = completion_is_honest(log)
    assert not honest and "only looked around" in reason


def test_completion_honest_for_a_read_only_task_that_returned_content():
    # a legit "tell me what's on the page" task: no action, but a read got content
    log = [p_ok("BrowserGetText", "The page says hello world")]
    honest, reason = completion_is_honest(log)
    assert honest and reason == ""


def test_completion_honest_when_some_errors_but_an_action_landed():
    # partial failure is fine as long as a real action ultimately succeeded
    log = [p_err("BrowserClick"), p_err("BrowserClick"), p_ok("BrowserClickIndex", "Clicked Submit")]
    honest, reason = completion_is_honest(log)
    assert honest


def test_card_is_unavailable_only_for_unrecoverable_errors():
    # a gone card is unrecoverable (fail fast); a missing selector is not (route around)
    assert card_is_unavailable({"error": "Browser card 'b1' not found or not an Electron webview"})
    assert card_is_unavailable({"error": "No dashboard is connected. Open the dashboard to use browser tools."})
    # a HUNG card (the 20-min LinkedIn freeze) also counts: commands time out, the page never responds, retrying is pointless -> same fast-fail streak as gone
    assert card_is_unavailable({"error": "Browser command timed out"})
    assert card_is_unavailable({"error": "page unresponsive"})
    # but normal, recoverable problems do NOT (the agent can route around these)
    assert not card_is_unavailable({"error": "Element not found: '.submit'"})
    assert not card_is_unavailable({"text": "ok", "url": "http://x"})


# --- informational-deliverable gate (don't record a thin shortcut for a run whose answer was gathered/judged content that replay can't reproduce) ---------

def test_deliverable_informational_blocks_gathered_content_records_confirmations():
    # a short action confirmation (the PROVEN Wikipedia case) -> safe to record
    assert not deliverable_is_informational(
        "Done. The search landed on the Alan Turing article: "
        "https://en.wikipedia.org/wiki/Alan_Turing")
    assert not deliverable_is_informational("Done, clicked Submit.")
    # a gathered list/report (the 'find me 10 X' case) -> NOT safe to record
    ten = "\n".join(f"{i}. Person {i} - Design Engineer at Co{i}" for i in range(1, 11))
    assert deliverable_is_informational(ten)
    # long single blob of extracted info also counts
    assert deliverable_is_informational("Here is what I found: " + "x" * 400)
    # empty / trivial -> not informational
    assert not deliverable_is_informational("")
