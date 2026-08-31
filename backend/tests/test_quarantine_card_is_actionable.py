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


def test_the_card_offers_the_step_people_give_up_on():
    """Step 4 (the exclusion) is what makes the fix STICK, and doing it by hand is where a real user
    stopped ("don't know how to take a file out of quarantine"). The app can do that step itself
    now (ENG-422), so the card has to say so or the automation is invisible to the person who
    needs it."""
    low = CARD.lower()
    assert "antivirus exclusion" in low, "the card must name the toggle that does step 4"
    assert "settings" in low and "advanced" in low, "and where to find it"
    # It stays an OFFER, not a claim that anything already happened.
    assert "approve" in low, "the user still consents through Windows' own dialog"


def test_the_retaken_repair_names_the_same_toggle():
    from backend.apps.agents.core.cli_self_heal import RepairResult
    import inspect
    from backend.apps.agents.core import cli_self_heal
    src = inspect.getsource(cli_self_heal.repair_bundled_cli)
    i = src.index("retaken=True")
    tail = src[i:i + 400].lower()
    assert "antivirus exclusion" in tail, (
        "the retaken branch is the one signal that PROVES an exclusion is needed; it must name it"
    )
    assert RepairResult(repaired=True, retaken=True).retaken is True
