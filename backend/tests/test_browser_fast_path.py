from backend.apps.agents.browser.browser_fast_path import (
    normalize_for_classifier,
    parse_verdict_and_brief,
    compose_task,
    dispatch_failed,
    fast_path_eligible,
    recovery_task,
)


def test_browsy_first_messages_are_eligible():
    for p in (
        "go to tyler chen's linkedin hes in entrepreneurs first and text him 'hi'",
        "open hacker news and tell me the top story",
        "look up on amazon how much a herman miller aeron costs",
        "check https://example.com/pricing and summarize the tiers",
    ):
        assert fast_path_eligible(p, "agent", "dash1", True, False), p


def test_non_browsy_or_gated_messages_fall_through():
    assert not fast_path_eligible("write me a poem about autumn", "agent", "dash1", True, False)
    assert not fast_path_eligible("fix the bug in agent_manager.py", "agent", "dash1", True, False)
    browsy = "open hacker news and tell me the top story"
    assert not fast_path_eligible(browsy, "chat", "dash1", True, False)
    assert not fast_path_eligible(browsy, "agent", None, True, False)
    assert not fast_path_eligible(browsy, "agent", "dash1", False, False)
    assert not fast_path_eligible(browsy, "agent", "dash1", True, True)
    assert not fast_path_eligible("", "agent", "dash1", True, False)


def test_verdict_parsing_is_strict():
    v, brief = parse_verdict_and_brief("READ\nENTRY: https://news.ycombinator.com\n1. read top story")
    assert v == "read" and brief.startswith("ENTRY:") and "top story" in brief
    assert parse_verdict_and_brief("ACT\nENTRY: https://x.com")[0] == "act"
    assert parse_verdict_and_brief("yes") == ("act", "")
    assert parse_verdict_and_brief("NO") == ("no", "")
    assert parse_verdict_and_brief("Maybe\nENTRY: x") == ("no", "")
    assert parse_verdict_and_brief("") == ("no", "")
    long_brief = "ACT\n" + "x" * 2000
    assert len(parse_verdict_and_brief(long_brief)[1]) == 700


def test_fast_read_entry_extraction_and_thin_detection():
    from backend.apps.agents.browser.browser_fast_read import extract_entry_url, page_is_thin
    brief = "ENTRY: https://news.ycombinator.com/\n1. Load the page\n2. Read the top story"
    assert extract_entry_url(brief) == "https://news.ycombinator.com/"
    assert extract_entry_url("1. just steps, no entry") == ""
    assert extract_entry_url("entry: HTTPS://example.com/a).") == "HTTPS://example.com/a"
    assert page_is_thin("")
    assert page_is_thin("HTTP error 403 fetching https://x.com")
    assert page_is_thin("Refused to fetch http://169.254.169.254: private address")
    assert page_is_thin("Title\n\nshort body")
    assert not page_is_thin("Title\n\n" + "real content " * 60)


def test_compose_task_keeps_user_words_first():
    assert compose_task("go to hn", "") == "go to hn"
    composed = compose_task("go to hn", "ENTRY: https://news.ycombinator.com")
    assert composed.startswith("go to hn\n\n[routing brief")
    assert composed.endswith("ENTRY: https://news.ycombinator.com")


def test_dispatch_failure_detection_is_fail_closed():
    # The result dict's structured `done` is the signal now (set true only when the sub-agent called Done with success AND the honesty gate agreed).
    assert dispatch_failed({})
    assert dispatch_failed(None)
    assert dispatch_failed({"summary": "Error: browser card was deleted"})
    assert dispatch_failed({"summary": "couldn't find the thread", "done": False})
    assert dispatch_failed({"summary": "the browser became unresponsive", "error": "x"})
    assert dispatch_failed({"summary": "clicked around a bit"})  # no done -> failed
    assert not dispatch_failed({"summary": "Sent it, it's in the thread now.", "done": True})
    assert not dispatch_failed({"summary": "Done, I took care of that for you.", "done": True})


def test_recovery_task_verifies_before_repeating():
    t = recovery_task("text bob 'hi' on linkedin", "OUTCOME: NOT DONE - hung before confirming send")
    assert "text bob 'hi' on linkedin" in t
    assert "hung before confirming" in t
    assert "do NOT repeat it" in t
    assert "no report (the browser died)" in recovery_task("go to hn", "")


def test_text_normalizes_to_message_without_phone_number():
    assert (
        normalize_for_classifier("go to maya's linkedin and text her thanks")
        == "go to maya's linkedin and message her thanks"
    )
    assert normalize_for_classifier("keep texting until he replies").startswith("keep message")
    sms = "text 4085551234 saying im running late"
    assert normalize_for_classifier(sms) == sms
    count = "count messages containing the exact text r10-os"
    assert "message r10-os" in normalize_for_classifier(count)


def test_dispatch_refused_when_no_dashboard_connected(monkeypatch):
    import asyncio
    from backend.apps.agents.browser.browser_agent import run_browser_agents
    from backend.apps.agents.core import ws_manager as wsm

    # Dispatch now waits briefly for a momentary WS drop to reconnect; with a genuinely-closed window that wait just elapses and it still refuses without dispatching an agent or burning a turn. Zero the wait so the test is instant.
    monkeypatch.setattr(wsm, "P_WS_RECONNECT_WAIT_S", 0.0)
    assert not wsm.ws_manager.global_connections
    results = asyncio.run(run_browser_agents(tasks=[{"task": "go to example.com"}], model="sonnet"))
    assert len(results) == 1
    assert results[0]["summary"].startswith("Error: no dashboard window is connected")
    assert dispatch_failed(results[0])


def test_send_probe_verdict_parsing_order_and_fail_closed():
    from backend.apps.agents.browser.browser_fast_path import probe_verdict
    assert probe_verdict("OUTCOME: PAYLOAD-NOT-FOUND") == "not-found"
    assert probe_verdict("checked thread. OUTCOME: PAYLOAD-FOUND at 10:43 PM") == "found"
    assert probe_verdict("the browser became unresponsive") == "unknown"
    assert probe_verdict("") == "unknown"
    # a report quoting BOTH tokens must not read as found
    assert probe_verdict("PAYLOAD-FOUND? no: PAYLOAD-NOT-FOUND") == "not-found"


def test_send_probe_task_is_read_only_and_names_payload():
    from backend.apps.agents.browser.browser_fast_path import send_probe_task
    t = send_probe_task("dm tyler", "[test] hello r45-os")
    assert "READ-ONLY" in t and "[test] hello r45-os" in t
    assert "PAYLOAD-FOUND" in t and "PAYLOAD-NOT-FOUND" in t


def test_recovery_task_clearance_only_when_verified():
    from backend.apps.agents.browser.browser_fast_path import recovery_task
    hedged = recovery_task("dm tyler", "browser died")
    cleared = recovery_task("dm tyler", "browser died", verified_undelivered=True)
    assert "FIRST verify" in hedged and "NOT yet delivered" not in hedged
    assert "NOT yet delivered" in cleared and "exactly ONCE" in cleared


def test_send_probe_replies_are_honest():
    from backend.apps.agents.browser.browser_fast_path import (
        already_sent_reply, unverifiable_reply,
    )
    a = already_sent_reply("[test] hi r46-os", "OUTCOME: PAYLOAD-FOUND at 11:02 PM")
    assert "did NOT send it again" in a and "r46-os" in a
    u = unverifiable_reply("[test] hi r46-os", "browser became unresponsive")
    assert "not retrying" in u.lower() and "r46-os" in u


def test_entry_url_extracted_from_brief():
    from backend.apps.agents.browser.browser_fast_path import entry_url_from_brief
    brief = (
        "ENTRY: https://www.linkedin.com/search/results/people/?keywords=tyler%20chen\n"
        "1. Open the first matching profile\n2. Click Message\n3. Type the text"
    )
    assert entry_url_from_brief(brief) == (
        "https://www.linkedin.com/search/results/people/?keywords=tyler%20chen"
    )
    # case-insensitive, mid-brief, trailing punctuation stripped
    assert entry_url_from_brief("steps...\nentry: https://news.ycombinator.com/.") == "https://news.ycombinator.com/"
    assert entry_url_from_brief("no entry line here") == ""
    assert entry_url_from_brief("") == ""
    # never a non-http scheme
    assert entry_url_from_brief("ENTRY: javascript:alert(1)") == ""


def test_results_url_shapes():
    from backend.apps.agents.browser.browser_agent import RESULTS_URL_RE
    hits = [
        "https://www.linkedin.com/search/results/people/?keywords=tyler+chen",
        "https://www.google.com/search?q=anything",
        "https://www.reddit.com/search/?q=cats",
        "https://example.com/find?term=x",
    ]
    misses = [
        "https://www.linkedin.com/in/tylerchen1200/",
        "https://news.ycombinator.com/",
        "https://www.linkedin.com/messaging/thread/abc123/",
    ]
    for u in hits:
        assert RESULTS_URL_RE.search(u), u
    for u in misses:
        assert not RESULTS_URL_RE.search(u), u
