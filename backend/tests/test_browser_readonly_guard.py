"""A question about a post must never become another post.

A verification prompt quotes the very text it is asking about, so it looks identical to a send task:
quoted payload plus a composer equals fire. Measured live on a real LinkedIn account 2026-07-28:

    "say whether anything containing "<text>" is still there. Change nothing."

posted <text> to the feed. Only "verify whether" and "check whether" were in the guard, so the
question shape was matched by two exact phrasings rather than by what it actually is.

The guard fails SAFE in the other direction: a false match only means the send goes through the
model path instead of the script, which costs turns, never a wrong action.
"""
from backend.apps.agents.browser import browser_send_parse as sp

# Every one of these is somebody asking a QUESTION about content, with the content quoted.
QUESTIONS = [
    'say whether anything containing "hello there" is still there. Change nothing.',
    'check whether "hello there" is still on my profile',
    'verify whether the post "hello there" went through',
    'tell me if "hello there" is still published',
    'confirm whether "hello there" posted',
    'is "hello there" still there?',
    'is the post "hello there" still live',
    'find out if "hello there" is still up',
    'look for "hello there" without posting anything',
    'this is read-only, do not post: is "hello there" there',
    'do not change anything, just say if "hello there" is present',
]

# Real send intents that must STILL fire the script; over-widening the guard would quietly disable
# the whole fast write path, which is the failure mode on the other side.
SENDS = [
    'post this, exactly: "hello there"',
    'tweet "hello there"',
    'message Tyler and say "hello there"',
    'reply to that thread with "hello there"',
    'comment "hello there" on the first post',
    'send "hello there" to my brother on whatsapp',
    'put "hello there" in a new linkedin post',
]


def test_every_question_shape_declines():
    missed = [q for q in QUESTIONS if not sp.is_readonly(q)]
    assert not missed, f"these questions would be treated as sends: {missed}"


def test_the_exact_prompt_that_posted_for_real_is_caught():
    """The literal string that put a test post on a real LinkedIn feed."""
    assert sp.is_readonly(
        'Go to linkedin.com and say whether anything containing "x" is still there. Change nothing.')


def test_real_sends_still_fire():
    blocked = [s for s in SENDS if sp.is_readonly(s)]
    assert not blocked, f"the guard swallowed real send intents: {blocked}"


def test_the_guard_is_case_and_spacing_insensitive():
    assert sp.is_readonly('IS  "hello"  STILL  THERE?')
    assert sp.is_readonly("Tell me if it posted")


def test_empty_and_junk_are_not_readonly():
    """An empty task is not a question; treating it as read-only would silently disable the script
    on a malformed input rather than letting the normal gates decide."""
    assert not sp.is_readonly("")
    assert not sp.is_readonly("   ")


# --- surface targeting: a post is not a comment ---------------------------------------------

def test_a_post_task_rejects_a_comment_box():
    """Measured: on LinkedIn's feed the capped listing starved the post modal of its own composer,
    so the only compose-shaped textbox left was a stranger's comment box. Filling it is the wrong
    action on the wrong content, not a slower route to the right one."""
    assert sp.surface_mismatch('post this, exactly: "hi"', "Text editor for creating comment")
    assert sp.surface_mismatch("start a post saying hi", "Add a comment")
    assert sp.surface_mismatch("tweet hello", "Post your reply")


def test_a_comment_task_keeps_its_comment_box():
    """One-directional by design: asking to comment must still land in a comment box."""
    assert not sp.surface_mismatch("comment on the first post saying hi", "Text editor for creating comment")
    assert not sp.surface_mismatch("reply to that thread with hi", "Add a comment")
    assert not sp.surface_mismatch("respond to his post", "Post your reply")


def test_a_post_task_keeps_a_real_post_composer():
    assert not sp.surface_mismatch('post this, exactly: "hi"', "Post text")
    assert not sp.surface_mismatch("start a post", "Share your thoughts")
    assert not sp.surface_mismatch("tweet hello", "What is happening?")


def test_a_task_with_no_post_intent_is_left_alone():
    """Messaging a person is neither posting nor commenting; the guard must not touch it."""
    assert not sp.surface_mismatch("text tyler hello", "Write a message")
    assert not sp.surface_mismatch("", "Add a comment")
