"""The agent answered a plainly English message in Vietnamese (live, 2026-08-31, workflow step).

Nothing in the shipped prompt said which language to reply in, so a terse or ambiguous turn could
drift into a language the user never chose. The tell in the screenshot: the ONE English line left
was "Other... / Answer in your own words", which is our own injected string, while every line the
model authored had drifted.

Anchored to the user's own words rather than the stored `locale`, which is analytics-only and never
reaches a prompt; the person typing is the only reliable signal of what they want to read.
"""
from backend.apps.settings.models import DEFAULT_SYSTEM_PROMPT
from backend.apps.settings.store import (
    P_LEGACY_DEFAULT_SYSTEM_PROMPTS,
    P_LEGACY_NO_LANGUAGE_ANCHOR,
)


def test_the_shipped_prompt_names_the_reply_language():
    low = DEFAULT_SYSTEM_PROMPT.lower()
    assert "language they wrote to you in" in low
    # UI text is where it actually hurt: an AskUI question is unreadable, not just oddly worded.
    assert "ui text" in low, "the anchor must cover generated UI text, not only prose"


def test_it_anchors_on_the_user_not_a_stored_locale():
    """A stored locale is a machine setting; the message in front of the model is the live fact."""
    assert "locale" not in DEFAULT_SYSTEM_PROMPT.lower()


def test_existing_installs_actually_migrate_onto_it():
    """The default persists into settings.json, so a new constant alone changes nothing for anyone
    who has already run the app. The pre-anchor revision has to be a recognised legacy revision."""
    assert P_LEGACY_NO_LANGUAGE_ANCHOR in P_LEGACY_DEFAULT_SYSTEM_PROMPTS
    assert "language they wrote to you in" not in P_LEGACY_NO_LANGUAGE_ANCHOR.lower()


def test_the_legacy_revision_differs_ONLY_by_the_anchor():
    """Derived, not hand-copied: a hand-copy silently stops matching the moment the rest of the
    prompt changes, and then the migration quietly stops upgrading anybody."""
    restored = P_LEGACY_NO_LANGUAGE_ANCHOR.replace(
        "Keep responses brief and direct. Use plain language.\n",
        "Keep responses brief and direct. Use plain language.\n"
        "Write to the user in the language THEY wrote to you in. If their message is in English, "
        "answer in English, including questions and any UI text you generate.\n",
    )
    assert restored == DEFAULT_SYSTEM_PROMPT


def test_a_user_customized_prompt_is_never_overwritten():
    """The migration is verbatim-match only; someone who edited their prompt keeps it."""
    mine = DEFAULT_SYSTEM_PROMPT + "\nAlways call me Captain.\n"
    assert mine not in P_LEGACY_DEFAULT_SYSTEM_PROMPTS
