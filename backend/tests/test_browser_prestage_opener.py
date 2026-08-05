"""Opener-mode block rule (the coverage treatment). The safety-critical property:
a compose-entry word (post/comment/reply/...) is allowed to REVEAL a composer only
while none is present, and is REFUSED the instant a composer textbox exists (then the
same word is the real submit). Hard-irreversible words are refused in every mode, and
opener-mode-off is byte-identical to the legacy blanket gate."""
import pytest

from backend.apps.agents.browser import browser_prestage as pre
from backend.apps.agents.browser import browser_send_script as script

COMPOSER_PRESENT = '[2]<textbox "Write a message">\n[14]<button "Post">'
NO_COMPOSER = '[1]<link "Home">\n[9]<button "Create post">\n[10]<button "Start a post">'


def test_opener_mode_off_is_legacy_blanket_gate(monkeypatch):
    monkeypatch.delenv("OSW_PRESTAGE_OPENER", raising=False)
    # legacy blanket gate refuses its own word set regardless of composer state (and
    # "Reply" was never in it, so legacy lets it through: exactly the gap the treatment closes)
    assert pre.click_refused('[9]<button "Create post">', NO_COMPOSER) is True
    assert pre.click_refused('[9]<button "Submit">', NO_COMPOSER) is True
    assert pre.click_refused('[9]<link "Jobs">', NO_COMPOSER) is False


def test_opener_allows_compose_entry_when_no_composer(monkeypatch):
    monkeypatch.setenv("OSW_PRESTAGE_OPENER", "1")
    # composer absent => these OPEN a box, so allowed
    assert pre.click_refused('[9]<button "Create post">', NO_COMPOSER) is False
    assert pre.click_refused('[10]<button "Start a post">', NO_COMPOSER) is False
    assert pre.click_refused('[3]<button "Add a comment">', NO_COMPOSER) is False
    assert pre.click_refused('[5]<button "Reply">', NO_COMPOSER) is False
    assert pre.click_refused('[7]<button "Post">', NO_COMPOSER) is False


def test_opener_refuses_submit_once_composer_present(monkeypatch):
    """THE safety invariant: the same 'Post' word that opened a box is the SUBMIT once
    a composer textbox is in perception, so it must be refused there."""
    monkeypatch.setenv("OSW_PRESTAGE_OPENER", "1")
    assert pre.click_refused('[14]<button "Post">', COMPOSER_PRESENT) is True
    assert pre.click_refused('[14]<button "Reply">', COMPOSER_PRESENT) is True
    assert pre.click_refused('[14]<button "Comment">', COMPOSER_PRESENT) is True


def test_opener_hard_blocks_irreversible_always(monkeypatch):
    """Pay/Buy/Delete/Send/Submit/Subscribe are NEVER composer-openers: refused even
    on a composer-absent page, both modes."""
    monkeypatch.setenv("OSW_PRESTAGE_OPENER", "1")
    for word in ("Send", "Submit", "Pay", "Buy now", "Delete", "Subscribe", "Confirm", "Connect"):
        assert pre.click_refused(f'[9]<button "{word}">', NO_COMPOSER) is True, word


def test_opener_allows_plain_navigation(monkeypatch):
    monkeypatch.setenv("OSW_PRESTAGE_OPENER", "1")
    assert pre.click_refused('[1]<link "Notifications">', NO_COMPOSER) is False
    assert pre.click_refused('[2]<button "Open first post">', NO_COMPOSER) is False


def test_deeper_reach_only_in_opener_mode(monkeypatch):
    monkeypatch.setenv("OSW_SEND_SCRIPT", "0")   # isolate the opener flag from its default-on family
    monkeypatch.setenv("OSW_PRESTAGE_OPENER", "1")
    assert pre.opener_mode() is True
    monkeypatch.delenv("OSW_PRESTAGE_OPENER", raising=False)
    assert pre.opener_mode() is False
    assert pre.OPENER_MAX_STEPS > pre.MAX_STEPS


def test_send_script_family_ships_on(monkeypatch):
    # Pins the ship decision, because the whole family hangs off this one default and the suite
    # itself pins it OFF in conftest for determinism (so a green suite proves nothing about it).
    monkeypatch.delenv("OSW_SEND_SCRIPT", raising=False)
    monkeypatch.delenv("OSW_AUTOSEND", raising=False)
    monkeypatch.delenv("OSW_PRESTAGE_OPENER", raising=False)
    assert script.script_enabled() is True
    assert script.autosend_enabled() is True
    assert pre.opener_mode() is True


def test_send_script_enables_opener_mode(monkeypatch):
    # The coupling: the send-script needs a composer to fire and the opener is what reaches one,
    # so enabling the send-script turns the opener on even without its own flag (else prestage
    # lands on a search page, the send-script declines, and the slow model loop runs).
    monkeypatch.delenv("OSW_PRESTAGE_OPENER", raising=False)
    monkeypatch.setenv("OSW_SEND_SCRIPT", "1")
    assert pre.opener_mode() is True
    monkeypatch.setenv("OSW_SEND_SCRIPT", "0")
    assert pre.opener_mode() is False


def test_half_an_emoji_cannot_kill_the_whole_prestage():
    """Live on twitch: a lone surrogate in the page text raised "'utf-8' codec can't encode
    character '\\ud83e'" out of the aux request encode, prestage's blanket except swallowed it as
    "[browser-prestage] skipped (...)", and the site lost its entire composer-reach stage. The
    agent loop already knew this (strip_lone_surrogates, written for the same detonation); prestage
    just never applied it. The scrub now sits on perceive(), the one door page text comes through.
    """
    from backend.apps.agents.browser.strip_lone_surrogates import strip_lone_surrogates

    raw = "chat \ud83e is half an emoji"
    with pytest.raises(UnicodeEncodeError):
        raw.encode("utf-8")
    cleaned = strip_lone_surrogates(raw)
    assert cleaned.encode("utf-8"), "must survive the encode that killed the stage"
    assert "\ud83e" not in cleaned
    # A well-formed emoji is left alone; scrubbing real content would be its own bug.
    assert strip_lone_surrogates("done \U0001f9e0 ok") == "done \U0001f9e0 ok"
    assert strip_lone_surrogates("") == ""


def test_ready_on_a_page_with_nowhere_to_write_gets_one_nudge():
    """The instagram/tiktok shape, measured live 2026-08-02 at N=5: 0/4 each, every run declining
    downstream with composer=0 textboxes=0.

    Prestage took the aux model's word for "READY". On instagram it replied "I can see the Instagram
    home page is loaded" and called READY from the feed; on tiktok it said "CLICK [1] READY" in one
    breath, declaring done before the click it had just asked for could open anything. Both burned
    the whole stage and handed the send script a page with no box in it.

    A send task is not staged until something can be written into. The gate is the same shape as the
    results-list overrule beside it: nudge once, accept a second READY, because some surfaces really
    do hide their box behind an opener the fill tier clicks later.
    """
    from backend.apps.agents.browser.browser_send_parse import composer_index_in_state
    assert composer_index_in_state(NO_COMPOSER) is None, "the feed shape must read as no composer"
    assert composer_index_in_state(COMPOSER_PRESENT) is not None, "a staged page must read as one"


def test_a_composer_already_on_the_page_needs_no_aux_call():
    """Criterion 5's tier-0. Measured: a steps=0 prestage took 4.6s median, and essentially all of
    it was one aux LLM call (1.7-6.5s) asking whether a page was ready that already was.

    "Staged" means a composer is visible. The perception answers that directly, so on this path the
    model can only agree at a cost. It stays as the fallback for pages where the box must be found.

    The condition is deliberately the SAME one the READY postcondition enforces (a send task is not
    staged until there is somewhere to write), so the fast path and the safety check can never
    disagree about what staged means.
    """
    import inspect
    from backend.apps.agents.browser import browser_prestage as pre
    src = inspect.getsource(pre)
    i = src.index("TIER 0")
    block = src[i:i + 700]
    assert "composer_index_in_state(li_text)" in block, "tier-0 must key on a visible composer"
    assert "task_is_send" in block, "and only for a send task; a read has different staging"
    assert block.index("staged_complete = True") < block.index("p_t_aux = time.monotonic()") \
        if "p_t_aux = time.monotonic()" in block else True, "it must short-circuit BEFORE the aux call"


def test_a_click_that_reveals_the_composer_ends_the_stage_without_another_aux_call():
    """The lazily-mounted editor shape, found by the editor-shape holdout on ckeditor.com.

    Its demo page lists a TAB LINK and no textbox, because CKEditor mounts only after the tab is
    clicked. Prestage clicked the tab, settled, incremented the step, and looped back into a full
    aux call, so on a 1-step budget the run ended with the send script never running at all
    ("sendscript" appears 0 times in the log). 0/2 on the holdout.

    settle() has already re-perceived to prove the page changed, so the new element list is in hand.
    Asking a model whether a composer is now visible costs 1.2-6.5s to re-read what we can read for
    free. Same condition as the pre-click tier-0 and as the READY postcondition, so all three agree
    on what "staged" means.
    """
    import inspect
    from backend.apps.agents.browser import browser_prestage as pre
    src = inspect.getsource(pre)
    i = src.index("The click may BE the answer")
    block = src[i:i + 900]
    assert "composer_index_in_state(p_after)" in block, "must check the POST-click perception"
    assert "task_is_send" in block, "send tasks only; a read stages differently"
    assert "staged_complete = True" in block, "and it must end the stage, not just note it"


def test_a_page_that_loaded_content_counts_as_settled_even_with_an_empty_before_state():
    """Found on disqus via the editor-shape holdout, and it is general.

    settle() proves an action took by asking "is the page DIFFERENT now?", comparing url, the first
    400 chars of text, and the element list against the pre-action snapshot. On a fresh card the
    pre-state is empty, so `pre_li` is falsy and the element-list clause is skipped entirely; a page
    whose URL the aux navigated to directly, and whose text starts empty, can satisfy none of the
    clauses no matter how well it loads.

    Measured: the disqus embed URL served 200, the navigation landed, settle returned ok=False after
    3.4s, prestage stopped unstaged, and BrowserListInteractives was NEVER CALLED. Downstream that
    read as "no composer" when the truth was that we never looked. Having content is itself the
    evidence a navigation settled.
    """
    import inspect
    from backend.apps.agents.browser import browser_prestage as pre
    src = inspect.getsource(pre)
    i = src.index("async def settle")
    body = src[i:i + 2200]
    assert "or (li2 and not pre_li)" in body, \
        "a load into an empty before-state must count as settled"
    # and the original difference clauses must survive: this is an ADDITION, not a replacement
    assert "u2 != pre_url" in body and "gt2[:400] != pre_text[:400]" in body
    assert "li2 != pre_li" in body
