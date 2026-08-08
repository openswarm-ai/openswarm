"""One release story, three surfaces. A release with no story, or a Help agent answering from a
stale picture of the app, are both bugs this pins shut."""

from backend.apps.help.changelog import (
    all_versions, as_markdown, help_context_block, latest_release, release_notes,
)
from backend.apps.service.version import APP_VERSION


def test_the_shipping_version_has_a_story():
    note = release_notes(APP_VERSION)
    assert note is not None, f"{APP_VERSION} ships with no release notes; write them before tagging"
    assert note.headline and (note.highlights or note.fixes)


def test_notes_are_written_for_users_not_committers():
    for note in (latest_release(),):
        for line in note.highlights + note.fixes:
            assert not line.startswith("["), "no commit-style prefixes"
            assert "commit" not in line.lower() and "refactor" not in line.lower()
            assert "—" not in line and "–" not in line, "house style: no em/en dashes"


def test_no_em_dashes_anywhere_in_a_release_body():
    # House rule, and the header was the one place the earlier test did not look.
    md = as_markdown(latest_release())
    assert "\u2014" not in md and "\u2013" not in md, "release bodies use plain punctuation"


def test_markdown_body_carries_the_same_words_as_the_app():
    note = latest_release()
    md = as_markdown(note)
    assert note.headline in md
    for line in note.highlights + note.fixes:
        assert line in md, "the GitHub body must not drift from the in-app card"


def test_help_context_names_the_version_and_its_changes():
    block = help_context_block(APP_VERSION)
    assert APP_VERSION in block
    note = release_notes(APP_VERSION)
    assert note is not None
    assert note.highlights[0] in block


def test_unknown_version_falls_back_to_the_latest_story_not_silence():
    assert release_notes("0.0.0") is None
    assert latest_release().version in help_context_block("0.0.0")
    assert len(all_versions()) >= 2
