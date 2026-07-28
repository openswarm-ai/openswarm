"""The browser trace: every tier owes the user the same auditable record.

The bug this exists for: the expandable Browser Agent panel renders from CHILD SESSIONS, which only
the sub-agent path creates. The fast path closed its bubble with a tool_result of literally "done",
so on the tier that handles most tasks there was nothing to expand. "Trust me, I did it" is exactly
what a browser agent must never say.
"""
from backend.apps.agents.browser import browser_trace as bt

NAV = {"tool": "BrowserNavigate", "input": {"url": "https://x.com/compose/post"},
       "elapsed_ms": 820, "ok": True}
TYPE = {"tool": "BrowserType", "input": {"text": "hello from my automation"}, "elapsed_ms": 140, "ok": True}
CLICK = {"tool": "BrowserClickByName", "input": {"name": "Post"}, "elapsed_ms": 310, "ok": True}


def test_the_trace_says_where_it_went_and_what_it_did():
    t = bt.build_trace("drove the browser", [[NAV, TYPE, CLICK]])
    assert t.pages == ["https://x.com/compose/post"]
    assert len(t.steps) == 3
    text = bt.trace_text(t)
    assert "x.com/compose/post" in text
    assert "hello from my automation" in text, "what was typed is the whole point of an audit"
    assert "Post" in text


def test_the_receipt_is_its_own_field_not_buried_in_the_steps():
    """The receipt is what separates 'it says it posted' from 'it posted', so it must be
    structurally distinguishable, not a line the user has to spot among forty."""
    t = bt.build_trace("drove the browser", [[NAV]], receipt="composer cleared, post is on your profile")
    assert t.receipt.startswith("composer cleared")
    assert "Verified: composer cleared" in bt.trace_text(t)


def test_every_dispatch_shows_up_not_just_the_last():
    """A fast-path run can dispatch more than once (a recovery, a send probe). That work happened on
    the user's behalf, so hiding all but the final attempt would misrepresent what was done."""
    t = bt.build_trace("drove the browser", [[NAV], [TYPE, CLICK]])
    assert len(t.steps) == 3


def test_a_long_run_says_what_it_omitted_instead_of_silently_truncating():
    """A trace the user cannot tell is partial is worse than no trace, because they would read it as
    the whole story."""
    t = bt.build_trace("drove the browser", [[NAV] * (bt.MAX_STEPS + 12)])
    assert len(t.steps) == bt.MAX_STEPS
    assert t.steps_omitted == 12
    assert "12 earlier steps omitted" in bt.trace_text(t)


def test_pages_read_as_a_journey_not_a_log():
    """Consecutive repeats collapse (a reload is not a new place) but a genuine return does not, so
    the list reads as where it went, in order. Revisiting after going elsewhere is real movement and
    must survive."""
    home = {"tool": "BrowserNavigate", "input": {"url": "https://x.com/home"}, "ok": True}
    t = bt.build_trace("x", [[NAV, TYPE, NAV, home, home]])
    assert t.pages == ["https://x.com/compose/post", "https://x.com/home"]

    back = bt.build_trace("x", [[NAV, home, NAV]])
    assert back.pages == ["https://x.com/compose/post", "https://x.com/home", "https://x.com/compose/post"]


def test_the_landing_page_shows_even_when_nothing_navigated():
    """Measured live: a cold run creates the card ALREADY pointed at its target, so no
    BrowserNavigate is ever issued and a log-only trace could not say where the agent went. The
    first thing anyone wants from an audit is the destination, so the entry URL is carried in."""
    reads = [{"tool": "BrowserGetText", "input": {}}, {"tool": "BrowserListInteractives", "input": {}}]
    t = bt.build_trace("drove the browser", [reads], entry_url="https://claude.ai/")
    assert t.pages == ["https://claude.ai/"]
    assert "claude.ai" in bt.trace_text(t)


def test_the_landing_page_is_not_duplicated_when_it_did_navigate():
    t = bt.build_trace("x", [[NAV]], entry_url="https://x.com/compose/post")
    assert t.pages == ["https://x.com/compose/post"]


def test_a_junk_entry_url_is_ignored_rather_than_shown():
    t = bt.build_trace("x", [[NAV]], entry_url="not a url")
    assert t.pages == ["https://x.com/compose/post"]


def test_a_failed_step_is_marked_not_hidden():
    """A run that limped to its answer must not read as a clean one."""
    bad = {"tool": "BrowserClickByName", "input": {"name": "Post"}, "ok": False}
    assert "(failed)" in bt.trace_text(bt.build_trace("x", [[bad]]))


def test_no_actions_is_stated_plainly_rather_than_rendering_blank():
    """The old failure mode was an empty panel, which reads as a broken UI rather than as a run that
    genuinely did nothing in a browser."""
    assert bt.trace_text(bt.build_trace("", [], "")) == "No browser actions were recorded."
    assert bt.trace_text(bt.build_trace("", [[]], "")) == "No browser actions were recorded."


def test_tier_is_described_in_words_a_user_understands():
    """'read->browser' is a routing string from a log line, not something anyone should be shown."""
    assert bt.tier_label("read", used_browser=False) == "read the page directly, no browser needed"
    assert "browser" in bt.tier_label("read->browser", used_browser=True)
    assert "->" not in bt.tier_label("read->browser", used_browser=True)


def test_the_payload_is_data_so_the_panel_never_parses_prose():
    t = bt.build_trace("drove the browser", [[NAV, TYPE]], receipt="delivered")
    payload = bt.trace_payload(t)["browser_trace"]
    assert payload["pages"] == ["https://x.com/compose/post"]
    assert payload["receipt"] == "delivered"
    assert isinstance(payload["steps"], list)


def test_malformed_entries_never_break_the_trace():
    """action_log comes from a live run; a half-written entry must degrade to a readable line rather
    than take down the record of everything that DID happen."""
    junk = [{}, {"tool": None}, {"tool": "X", "input": "not-a-dict"}, {"input": {"url": 5}}]
    text = bt.trace_text(bt.build_trace("x", [junk]))
    assert text and "Traceback" not in text


def test_the_fast_path_actually_emits_a_trace():
    """INVARIANT: the whole point is that the tier which handles most tasks stops closing its bubble
    with the string "done". Pinned by source because the emission sits inside a long async flow."""
    import inspect

    from backend.apps.agents.manager import run_browser_fast_path as fp

    src = inspect.getsource(fp.run_browser_fast_path)
    assert '"text": "done"' not in src, 'the placeholder result is back; the bubble expands to nothing again'
    assert "browser_trace.trace_payload" in src, "the bubble must carry the structured trace"
