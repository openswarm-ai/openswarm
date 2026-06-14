from backend.apps.agents.core.aux_llm import clean_short_label


def test_clean_label_passthrough():
    assert clean_short_label("Travel planning") == "Travel planning"


def test_markdown_essay_becomes_short():
    raw = "# Git Rebase Explained\nGit rebase is a way to integrate changes from one branch"
    assert clean_short_label(raw) == "Git Rebase Explained"


def test_first_line_word_cap():
    assert clean_short_label("one two three four five six") == "one two three four"


def test_char_cap_lands_on_word_boundary():
    out = clean_short_label("supercalifragilistic expialidocious antidisestablishmentarianism", max_words=4)
    assert len(out) <= 36
    assert not out.endswith(" ")


def test_refusals_rejected():
    for bad in [
        "I cannot generate a name without more information",
        "Sorry, there is no task to summarize",
        "I'm unable to help with that",
        "As an AI, I need more context",
        "Unfortunately no information was provided",
    ]:
        assert clean_short_label(bad) == ""


def test_quotes_and_bullets_stripped():
    assert clean_short_label('"**Code review**"') == "Code review"
    assert clean_short_label("- Sales dashboard.") == "Sales dashboard"


def test_empty_and_whitespace():
    assert clean_short_label("") == ""
    assert clean_short_label("\n\n  \n") == ""


def test_ing_words_not_false_rejected():
    assert clean_short_label("Investigating the bug") == "Investigating the bug"
    assert clean_short_label("iOS app design") == "iOS app design"
