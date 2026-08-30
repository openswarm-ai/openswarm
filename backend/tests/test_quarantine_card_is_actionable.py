"""The AV-quarantine card has to be performable by the person who receives it.

Field evidence, 2026-08-29: a first-time user hit this card and replied "don't know how to take a
file out of quarantine". She is not an outlier -- 22 of 25 affected installs never produced another
agent reply. The old card named the right fix ("restore it from your antivirus quarantine and add an
exclusion") and gave no way to do it, which is a dead end dressed as guidance.

Row 4 on the ladder: the app is unusable, and the stated recovery empirically does not happen."""

import re

SRC = open("backend/apps/agents/manager/run/handle_run_error.py", encoding="utf-8").read()
# Anchor on THIS card's own words: the file holds several `friendly_msg = (` blocks and slicing the
# first one silently tested the long-context card instead.
_start = SRC.index("bundled agent runtime")
CARD = SRC[_start:SRC.index("error_msg = Message(", _start)]


def test_it_leads_with_the_fix_that_always_works():
    """Reinstall works for everyone; the quarantine dance works for the few who can do it. A card
    that opens with the harder path loses the readers who needed it most."""
    lower = CARD.lower()
    assert "reinstall" in lower
    assert lower.index("reinstall") < lower.index("windows security"), \
        "the always-works fix must come before the fiddly one"


def test_the_restore_path_is_actual_clicks():
    """Naming a destination is not instructions. These are the four screens a user has to touch."""
    lower = CARD.lower()
    for step in ("windows security", "protection history", "restore", "exclusion"):
        assert step in lower, f"the card never mentions {step!r}"


def test_it_says_why_the_exclusion_matters():
    """Restoring without an exclusion just gets it quarantined again, which is how someone 'fixes'
    it twice and gives up."""
    assert "quarantined again" in CARD.lower()


def test_it_still_reassures_about_data():
    """The single most common panic on this card is 'have I lost my chats'."""
    lower = CARD.lower()
    assert "chats and settings are safe" in lower or "your chats" in lower


def test_it_does_not_dump_the_dead_path():
    """The raw CLINotFoundError path was the original unactionable card; it must not come back."""
    assert "not found at" not in CARD.lower()
    assert not re.search(r"[A-Za-z]:\\\\", CARD), "no raw Windows path in the user-facing text"
