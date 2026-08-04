"""A composer on the wrong THING is still the wrong thing.

`surface_mismatch` already asks whether the composer contradicts the task (a post ask must not fill
a DM box). This is the same question one level up, about the page, because a page can hand you a
perfectly real composer that belongs to something nobody asked about.

Measured live on instagram 2026-08-04 at N=5: "write a comment on the first post" opened a STORY
(`/stories/<user>/`). A story's reply box IS a composer, so the DM guard, the structural finder and
the fill receipt were all satisfied, and the comment would have gone to a story silently. The URL is
the page's own declaration of what it is, and it was the only signal that disagreed.

Both sides must be unambiguous before this fires. The cost of a false positive is one declined fast
path (the model still gets the page); the cost of a false negative is a write to the wrong surface.
"""

from backend.apps.agents.browser import browser_send_parse as sp


def test_the_instagram_story_bug_verbatim():
    why = sp.content_type_mismatch("write a comment on the first post",
                                   "https://www.instagram.com/stories/miy.jpg/")
    assert why == "asked for a post, landed on a story", why


def test_the_same_task_on_a_real_post_is_fine():
    """The guard must not cost us the case that works: instagram reached /p/<id> on other runs."""
    assert sp.content_type_mismatch("write a comment on the first post",
                                    "https://www.instagram.com/p/DbRdbkgCZgk/") == ""


def test_asking_for_a_story_and_getting_one_is_fine():
    """The user is allowed to want a story. The guard is about disagreement, not about stories."""
    assert sp.content_type_mismatch("reply to the first story",
                                    "https://www.instagram.com/stories/miy.jpg/") == ""


def test_the_working_sites_are_untouched():
    """Every site at 5/5 or 4/4 in the N=5 sweep must keep scoring exactly as it did."""
    for task, url in (
        ("comment on the first video", "https://www.youtube.com/watch?v=SAjrSUNCQbc"),
        ("post this tweet", "https://x.com/compose/post"),
        ("create a text post", "https://www.reddit.com/r/test/submit/?type=TEXT"),
        ("create a post", "https://www.linkedin.com/feed/?shareActive=true"),
        ("write in chat", "https://www.twitch.tv/jynxzi"),
    ):
        assert sp.content_type_mismatch(task, url) == "", (task, url)


def test_it_stays_silent_when_either_side_is_unclear():
    """An ambiguous task names two types and a plain URL declares none. Guessing between them would
    refuse pages that were right all along, which costs more than the bug it would catch."""
    assert sp.content_type_mismatch("post a comment on the story",
                                    "https://www.instagram.com/stories/x/") == ""
    assert sp.content_type_mismatch("say hi to tyler", "https://example.com/anything") == ""
    assert sp.content_type_mismatch("", "https://www.instagram.com/stories/x/") == ""
    assert sp.content_type_mismatch("comment on the first post", "") == ""
