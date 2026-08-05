"""A cleared composer is not the only proof a post landed.

Measured on LinkedIn four separate times: the post LANDS, and the composer still holds the text 7.6s
later, so the two-sided receipt ("fill seen committed, then seen gone") reports a successful send as
unverified. An independent read of the activity feed found the post every time. That costs the fast
path (the model goes back to re-verify work that already succeeded, ~60s against ~24s) and it makes
criterion 2 under-report real capability.

The clear is ABSENCE evidence and some sites never supply it. Presence is the other direction, and
the COUNT is what makes it usable: one hit is ambiguous (a leftover draft or the posted item, no way
to tell them apart), two hits cannot both be the composer, so the second is rendered content.

Only runs when the clear-poll already failed, so a site whose composer does clear is untouched.
"""

import json

from backend.apps.agents.browser import browser_delivery_check as dc


def test_the_probe_counts_every_occurrence_not_just_the_first():
    expr = dc.occurrence_probe_expression("canary123")
    assert "while(i!==-1)" in expr, "must keep scanning past the first hit"
    assert "i+n.length" in expr, "and advance past the match, or it counts forever"


def test_the_needle_is_whitespace_normalised_and_capped():
    """innerText collapses whitespace; a payload with a newline would never match verbatim. The cap
    keeps a pasted essay from becoming an 80KB expression."""
    expr = dc.occurrence_probe_expression("hello   \n  world")
    assert json.dumps("hello world") in expr
    long_expr = dc.occurrence_probe_expression("z" * 300)
    assert json.dumps("z" * 80) in long_expr


def test_an_empty_payload_counts_nothing_rather_than_everything():
    """indexOf('') returns 0 forever. Without this guard the probe reports an infinite count and
    every send would 'verify'."""
    assert "if(!n.length) return {count:0};" in dc.occurrence_probe_expression("")


def test_a_page_error_is_reported_as_unreadable_not_as_zero():
    """-1 becomes None upstream. Asserting 'not there' from an observation that never happened is
    the same error as claiming a delivery nobody saw, pointed the other way."""
    assert "catch(e){return {count:-1};}" in dc.occurrence_probe_expression("x")


def test_the_send_script_requires_TWO_hits_before_it_believes_a_send():
    """One hit is the draft. The threshold is the safety property: at 1 this would call every
    unsent draft a delivered post, which is the false-success class the receipt exists to prevent."""
    import inspect
    from backend.apps.agents.browser import browser_send_script as ss
    src = inspect.getsource(ss)
    i = src.index("receipt via rendered content")
    block = src[max(0, i - 900):i + 200]
    assert "p_n is not None and p_n >= 2" in block, "two hits, and None must not pass"
    assert "payload_occurrences" in block


def test_it_only_runs_after_the_clear_poll_already_failed():
    """A site whose composer clears must pay nothing for this, and must not get a second opinion
    that could disagree with a receipt it already earned honestly."""
    import inspect
    from backend.apps.agents.browser import browser_send_script as ss
    src = inspect.getsource(ss)
    assert 'if not sent and p_why.startswith("payload-still")' in src
