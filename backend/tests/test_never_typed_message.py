"""A send that never typed anything must say so, not "check the page".

Reported live by Eric on 2026-08-04: "send hi to charles zheng on linkedin". The run's ENTIRE trace
was ListInteractives, GetText, ClickIndex(21), ListInteractives, GetText, ClickIndex(116),
ListInteractives, GetText. Two navigation clicks and three reads. Nothing was ever typed. It then
reported "the send was never confirmed, so it may not have gone out; check the page before trusting
this", which sends the user hunting for a message that was never composed and hides why the run
stopped early.

Both halves of that are failures, but they are DIFFERENT failures with different fixes: "we typed it
and could not prove it left" needs receipt work; "we never typed it" needs the payload. The gate now
distinguishes them, keyed on the text ARGUMENT rather than the tool name, because the same tool does
both jobs: BrowserClickIndex with a `text` arg is the fill path, without one it is navigation.

Root cause of the underlying decline, for the record: "send hi to X" carries no QUOTED payload, so
quoted_payload returns "" and the scripted send stands down by design (it will not guess which words
to send). That guard is right. What was wrong was the sentence the user got afterwards.
"""

from backend.apps.agents.browser.browser_loop import completion_is_honest, typed_anything

# Eric's trace, verbatim.
ERIC = [
    {"tool": "BrowserListInteractives", "ok": True},
    {"tool": "BrowserGetText", "ok": True},
    {"tool": "BrowserClickIndex", "ok": True, "input": {"index": 21}},
    {"tool": "BrowserListInteractives", "ok": True},
    {"tool": "BrowserGetText", "ok": True},
    {"tool": "BrowserClickIndex", "ok": True, "input": {"index": 116}},
    {"tool": "BrowserListInteractives", "ok": True},
    {"tool": "BrowserGetText", "ok": True},
]


def test_erics_run_is_told_nothing_was_typed():
    honest, why = completion_is_honest(ERIC, publish_task=True, send_confirmed=False)
    assert not honest
    assert "never actually typed" in why
    assert "check the page" not in why, "there is nothing on the page to check"
    assert "in quotes" in why, "and it must say what would let it succeed next time"


def test_a_run_that_did_type_keeps_the_unconfirmed_wording():
    """The other failure is still a failure, and still worth checking the page for."""
    typed = [{"tool": "BrowserClickIndex", "ok": True, "input": {"index": 5, "text": "hi"}}]
    honest, why = completion_is_honest(typed, publish_task=True, send_confirmed=False)
    assert not honest and "may not have gone out" in why


def test_typing_is_detected_by_the_text_argument_not_the_tool_name():
    """The distinction that makes this work: one tool, two jobs."""
    assert not typed_anything([{"tool": "BrowserClickIndex", "ok": True, "input": {"index": 3}}])
    assert typed_anything([{"tool": "BrowserClickIndex", "ok": True,
                            "input": {"index": 3, "text": "hello"}}])
    assert typed_anything([{"tool": "BrowserType", "ok": True, "input": {"selector": "#a"}}])


def test_a_typed_sub_action_inside_a_batch_counts():
    """The efficient path bundles type+press_key into one BrowserBatch; the text is a level down."""
    assert typed_anything([{"tool": "BrowserBatch", "ok": True, "input": {"actions": [
        {"type": "click_index", "params": {"index": 2}},
        {"type": "type", "params": {"selector": "#m", "text": "hello"}},
    ]}}])


def test_a_failed_fill_does_not_count_as_typing():
    """An attempt that errored put nothing in the box, so the user has nothing to check."""
    assert not typed_anything([{"tool": "BrowserClickIndex", "ok": False,
                                "input": {"index": 5, "text": "hi"}}])


def test_whitespace_is_not_a_message():
    assert not typed_anything([{"tool": "BrowserClickIndex", "ok": True,
                                "input": {"index": 5, "text": "   "}}])
