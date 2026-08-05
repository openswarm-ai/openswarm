"""A form whose submit is gated on a second field must still be sendable.

Measured live 2026-08-04: reddit's create-post flow could never complete. `/r/test/submit` exposes
`textbox "Title"` (required, and its submit stays DISABLED until filled) and `textbox "Post text"`.
Only the second matches composer vocabulary, so the send script filled the body, the title stayed
empty, the submit never enabled, and the run handed off every time. Every other supported surface is
a single box, so this was the one shape the single-composer design could not express.

The rule is deliberately narrow, and the narrowness is the safety:
  - EXACTLY one other empty non-auth textbox, so there is never a guess about which field to fill
  - the submit must ENABLE ON ITS OWN afterwards; we re-ask the page rather than assume
  - if it stays disabled, the old honest hand-off is unchanged and nothing is clicked

Auth fields are excluded via the same P_AUTH_FIELD_NAME_RE the login-wall gate uses, so a password
or email box beside a composer can never be treated as "the field the submit is waiting on".
"""

import inspect

from backend.apps.agents.browser import browser_send_parse as sp
from backend.apps.agents.browser import browser_send_script as ss

SRC = inspect.getsource(ss)


def p_missing(state, composer_index):
    """The selection rule under test, exactly as the send script applies it."""
    return [(i, n) for i, n in sp.P_COMPOSER_ROW_RE.findall(state)
            if int(i) != composer_index and not sp.P_AUTH_FIELD_NAME_RE.search(n or "")]


def test_the_reddit_shape_identifies_exactly_one_missing_field():
    """The perception verbatim. The composer is excluded BY INDEX: the row regex captures only the
    accessible name, so a filled box and an empty one look identical by name, and matching on the
    payload made every field read as still-empty (this test caught that)."""
    state = '[3]<textbox "Title">\n[7]<textbox "Post text">'
    missing = p_missing(state, composer_index=7)
    assert len(missing) == 1 and missing[0][1] == "Title", missing


def test_an_auth_field_is_never_mistaken_for_the_missing_field():
    """A password box beside a composer must not be filled with the user's post."""
    state = '[3]<textbox "Password">\n[7]<textbox "Post text">'
    assert p_missing(state, composer_index=7) == [], "an auth field must never be the target"


def test_two_empty_fields_stay_ambiguous_and_are_not_guessed():
    """Three-field forms are a different problem; guessing which one gates the submit is how you
    type a post into someone's phone-number box."""
    state = '[3]<textbox "Title">\n[5]<textbox "Flair">\n[7]<textbox "Post text">'
    assert len(p_missing(state, composer_index=7)) == 2, "two candidates must not collapse to a pick"


def test_the_submit_must_re_enable_on_its_own_before_any_click():
    """The safety property. Filling a field is reversible; clicking submit is not, so the page has
    to confirm the form is now valid rather than us assuming it."""
    i = SRC.index("filling it and re-checking the submit")
    block = SRC[i:i + 1500]
    assert "container_submit_expression" in block, "must re-ask the page whether the submit enabled"
    assert block.index("container_submit_expression") < block.index("BrowserClickPoint"), \
        "the re-check must happen BEFORE the click"
