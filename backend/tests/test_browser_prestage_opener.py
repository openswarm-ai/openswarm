"""Opener-mode block rule (the coverage treatment). The safety-critical property:
a compose-entry word (post/comment/reply/...) is allowed to REVEAL a composer only
while none is present, and is REFUSED the instant a composer textbox exists (then the
same word is the real submit). Hard-irreversible words are refused in every mode, and
opener-mode-off is byte-identical to the legacy blanket gate."""
import pytest

from backend.apps.agents.browser import browser_prestage as pre

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
    monkeypatch.setenv("OSW_PRESTAGE_OPENER", "1")
    assert pre.opener_mode() is True
    monkeypatch.delenv("OSW_PRESTAGE_OPENER", raising=False)
    assert pre.opener_mode() is False
    assert pre.OPENER_MAX_STEPS > pre.MAX_STEPS
