"""When the task names a field, write into THAT field.

Measured live on reddit 2026-08-05, twice in one round. Task: "create a text post whose title is
exactly canary5e95c195. Submit it." The compose-shaped picker chose 'Post body text field', which is
the right answer to the question it was asking (which box looks like a composer?) and the wrong
answer to the question that mattered (which box did the person mean?). reddit's Title stayed empty,
its submit stayed DISABLED, and the run could never complete: `submit 'post' is present but
DISABLED; the form is incomplete, handing to the model`, on every attempt.

The field word comes from the user's own sentence and must appear in the element's accessible name,
so this is not the picker guessing; it is the picker finally reading the instruction.
"""

from backend.apps.agents.browser import browser_send_parse as bp

# A reddit submit form as the perception lists it: a short Title input and the big body composer.
REDDIT = '[21]<textbox "Title" />\n[23]<textbox "Post body text field" />\n[25]<button "post" />'
# LinkedIn's post modal: one compose-shaped box, no named field anywhere.
LINKEDIN = '[54]<textbox "Text editor for creating content" />\n[57]<button "Post" />'


def test_a_named_title_beats_the_compose_shaped_guess():
    """The regression, exactly as it happened."""
    assert bp.composer_index_in_state(
        REDDIT, 'create a text post whose title is exactly "canary5e95c195"') == (21, "Title")


def test_without_a_field_word_the_old_picker_still_decides():
    """No hint means no change: every site that worked before must keep working."""
    assert bp.composer_index_in_state(
        REDDIT, 'create a text post with body "hello"') == (23, "Post body text field")
    assert bp.composer_index_in_state(
        LINKEDIN, 'create a post with exactly this text: "hello"') == (
            54, "Text editor for creating content")


def test_a_field_word_with_no_matching_box_changes_nothing():
    """LinkedIn has no Title field. Naming one must not break the composer it does have."""
    assert bp.composer_index_in_state(
        LINKEDIN, 'post with the title "hello"') == (54, "Text editor for creating content")


def test_two_boxes_matching_the_hint_stand_down():
    """Ambiguity is the model's problem here, same as everywhere else in this file."""
    two = '[1]<textbox "Title" />\n[2]<textbox "Subtitle title" />\n[3]<textbox "Post body text field" />'
    assert bp.hinted_field_in_state(two, 'post with the title "x"') is None
    # and the compose-shaped picker still answers
    assert bp.composer_index_in_state(two, 'post with the title "x"') == (3, "Post body text field")


def test_the_hint_words_stay_off_compose_shaped_fields():
    """'body', 'message' and 'comment' are deliberately NOT hints: those boxes are already found by
    shape, and a second route to the same element is a second thing to keep in sync. Asserted
    through the public finder, not the regex, so the test survives the pattern being rewritten."""
    for word, state in (
        ("body", '[1]<textbox "Post body text field" />'),
        ("message", '[1]<textbox "Write a message" />'),
        ("comment", '[1]<textbox "Add a comment" />'),
    ):
        assert bp.hinted_field_in_state(state, f'write the {word} "hello"') is None


def test_the_old_single_argument_call_still_works():
    """Callers outside the send script pass state only."""
    assert bp.composer_index_in_state(LINKEDIN) == (54, "Text editor for creating content")
