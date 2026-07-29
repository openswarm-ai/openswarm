"""The compose-entry table may only ever fire on a top-level create aimed at the bare site.

This tier navigates the user's real browser somewhere it chose, so its guards are the safety
surface, not the table. Composing in the wrong place is worse than not composing: a hijacked reply
posts a stranger's answer to the whole feed, and a hijacked permalink abandons the target the user
explicitly named. Both are silent, and neither is undone by the two-sided receipt downstream, which
proves only that SOMETHING was posted.

So the interesting cases here are all refusals.
"""
import pytest

from backend.apps.agents.browser import compose_entry as ce


# --- it fires where it should ------------------------------------------------------------------

@pytest.mark.parametrize("start,task,want_host", [
    ("https://x.com/home", 'post this tweet: "hello"', "x.com"),
    ("https://www.linkedin.com/feed/", 'start a post saying "hello"', "linkedin.com"),
    ("https://www.reddit.com/", 'start a text post whose body is "hello"', "reddit.com"),
    ("https://mail.google.com/mail/u/0/", 'compose an email saying "hello"', "mail.google.com"),
])
def test_a_top_level_create_gets_the_sites_compose_url(start, task, want_host):
    got = ce.compose_entry_for(task, start)
    assert got and ce.registrable_host(got) == want_host


def test_the_host_can_come_from_the_task_when_the_tab_is_blank():
    """A run that starts on about:blank still says where it is going."""
    got = ce.compose_entry_for('go to x.com and post "hello there"', "about:blank")
    assert got == "https://x.com/compose/post"


def test_subdomains_resolve_to_the_parent_sites_composer():
    assert ce.compose_entry_for('post "hello there"', "https://old.reddit.com/r/test") is not None


def test_www_and_mobile_prefixes_are_the_same_site():
    for host in ("www.x.com", "m.x.com", "mobile.x.com", "x.com"):
        assert ce.registrable_host(host) == "x.com"


# --- it refuses where it must ------------------------------------------------------------------

@pytest.mark.parametrize("task", [
    'reply to this tweet with "hello there"',
    'comment "nice work" on the top post',
    'respond to her message saying "hello there"',
    'quote tweet it with "hello there"',
    'send a DM saying "hello there"',
])
def test_answering_something_keeps_its_own_target(task):
    """A reply belongs on the thread in front of the user. Hijacking it to the site composer
    publishes a private answer to everyone, which is the worst failure this file guards."""
    assert ce.compose_entry_for(task, "https://x.com/home") is None


def test_the_refusals_above_are_caused_by_the_respond_word():
    """Positive control. Every refusal test would also pass if the tier were simply broken and
    always returned None, so prove the same sentence DOES fire once the answering word is gone."""
    assert ce.compose_entry_for('reply with "hello there"', "https://x.com/home") is None
    assert ce.compose_entry_for('post "hello there"', "https://x.com/home") is not None


def test_a_permalink_in_the_task_outranks_the_generic_composer():
    task = 'post "hello there" on https://x.com/someone/status/12345'
    assert ce.compose_entry_for(task, "https://x.com/home") is None


def test_a_bare_host_url_in_the_task_is_not_a_deeper_target():
    assert ce.compose_entry_for('go to https://x.com/ and post "hello there"', "about:blank") is not None


def test_a_query_or_fragment_also_counts_as_a_chosen_target():
    for url in ("https://www.reddit.com/?feed=home", "https://www.reddit.com/#top"):
        assert ce.compose_entry_for(f'post "hello there" at {url}', "https://www.reddit.com/") is None


def test_a_read_task_never_navigates():
    assert ce.compose_entry_for("what is the top post on reddit", "https://www.reddit.com/") is None


def test_an_unknown_site_is_left_alone():
    assert ce.compose_entry_for('post "hello there"', "https://example.com/") is None


def test_a_lookalike_domain_is_not_the_real_one():
    """`endswith("reddit.com")` matches `notreddit.com`. That would navigate a post intended for a
    site the user named to a completely different one."""
    for host in ("notreddit.com", "fake-x.com", "linkedin.com.evil.test"):
        assert ce.compose_entry_for('post "hello there"', f"https://{host}/") is None


def test_already_on_the_compose_surface_does_not_remount_it():
    """Re-navigating throws away a composer that is already open, and on a modal that means the
    user's half-typed state too."""
    assert ce.compose_entry_for('post "hello there"', "https://x.com/compose/post") is None
    assert ce.compose_entry_for('start a post "hello there"',
                                "https://www.linkedin.com/feed/?shareActive=true") is None


# --- the aux routing brief is commentary, not the request ---------------------------------------

def p_dispatched(prompt: str, brief: str) -> str:
    """Exactly what a dispatched browser task looks like: the user's words, then a brief a model
    wrote about routing them."""
    from backend.apps.agents.browser import browser_fast_path
    return browser_fast_path.compose_task(prompt, brief)


def test_a_brief_that_quotes_something_does_not_disarm_the_tier():
    """The live miss. The brief adds a second quoted span, `quoted_payload` calls the task
    ambiguous and returns "", and the tier silently declined on every real run while its unit tests
    (which passed the bare prompt) stayed green."""
    task = p_dispatched('Go to x.com and post this tweet, exactly: "coverage probe 1"',
                        'Open the composer and type the text. Click "Post" to publish.')
    assert ce.compose_entry_for(task, "") == "https://x.com/compose/post"


def test_a_brief_using_answering_words_does_not_disarm_the_tier():
    task = p_dispatched('post "hello there" on x.com',
                        'If a dialog appears, respond to it and reply to any prompt.')
    assert ce.compose_entry_for(task, "") is not None


def test_a_brief_naming_another_site_cannot_redirect_the_post():
    """Which site to open is the user's call. A brief is a model's guess and must not move a post
    to a different service."""
    task = p_dispatched('post "hello there" on x.com', 'You may find this on reddit.com instead.')
    assert ce.compose_entry_for(task, "") == "https://x.com/compose/post"


def test_only_a_permalink_the_USER_named_vetoes():
    """Measured live: briefs spell out a route ("navigate to https://x.com/home"), and letting that
    veto silently disabled the tier on x and linkedin while reddit worked. A brief cannot turn a
    post into a reply, because the words that would say so are the user's and are still read."""
    brief_only = p_dispatched('post "hello there" on x.com',
                              'The target appears to be https://x.com/someone/status/12345')
    assert ce.compose_entry_for(brief_only, "") == "https://x.com/compose/post"
    user_named = p_dispatched('post "hello there" on https://x.com/someone/status/12345',
                              'Open the composer.')
    assert ce.compose_entry_for(user_named, "") is None


# --- host parsing can't be sloppy ---------------------------------------------------------------

def test_prefix_stripping_uses_a_real_prefix_check():
    """`lstrip("www.")` eats any leading w or dot; it turns w3schools into 3schools."""
    assert ce.registrable_host("w3schools.com") == "w3schools.com"
    assert ce.registrable_host("wow.com") == "wow.com"


def test_ports_and_credentials_are_dropped():
    assert ce.registrable_host("https://user@x.com:443/home") == "x.com"


def test_garbage_never_raises():
    for bad in ("", "   ", "not a url", "://", "https://"):
        assert isinstance(ce.registrable_host(bad), str)
        assert ce.compose_entry_for('post "hello there"', bad) is None
