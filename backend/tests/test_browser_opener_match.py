"""Which control counts as a composer OPENER, and which must never be clicked as one.

The rule was exact names only ("Comment", "Message", ...), for a stated reason: a paid upsell like
"Send InMail" must never be reachable. That exactness also made it blind to every opener whose label
is a sentence. Measured live 2026-08-02: tiktok labels its button `Read or add comments 526
comments`, the match missed, and the site scored 0/4 while the aux model clicked at that very button
for 27.8s.

So the second half matches VERB + NOUN anywhere in the label, which keeps what exactness was buying:
a bare count has no verb, and an upsell has the wrong noun. Neither can reach a click through here.
"""

from backend.apps.agents.browser import browser_send_parse as sp


def test_an_opener_labelled_as_a_whole_sentence_is_still_an_opener():
    """tiktok, verbatim from the 2026-08-02 perception."""
    hit = sp.opener_index_in_state('[12]<button "Read or add comments 526 comments">')
    assert hit is not None and hit[0] == 12


def test_a_count_is_not_an_opener():
    """"526 comments" is a label on a number. Clicking things because they say "comments" is how a
    read turns into an action."""
    assert sp.opener_index_in_state('[12]<button "526 comments">') is None


def test_an_upsell_is_still_unreachable():
    """The reason the rule was exact in the first place. "Send InMail" costs money and is not a
    composer; the noun list is what keeps it out, so this test guards the noun list."""
    assert sp.opener_index_in_state('[4]<button "Send InMail">') is None
    assert sp.opener_index_in_state('[4]<button "Send gift">') is None
    assert sp.opener_index_in_state('[4]<button "Send tip">') is None


def test_a_destructive_control_is_not_an_opener():
    """"Delete comment" carries the noun but the wrong verb, and the verb list is what stops it."""
    assert sp.opener_index_in_state('[3]<button "Delete comment">') is None
    assert sp.opener_index_in_state('[3]<button "Report comment">') is None


def test_exact_names_still_win_unchanged():
    assert sp.opener_index_in_state('[3]<button "Comment">') is not None
    assert sp.opener_index_in_state('[3]<link "Message">') is not None


def test_two_candidates_stay_ambiguous():
    """A singleton or nothing. Picking one of two openers is a coin flip on which surface gets
    written to, and that is the class of bug that once filled a stranger's DM box."""
    assert sp.opener_index_in_state(
        '[3]<button "Add a comment">\n[9]<button "Write a reply">') is None


def test_the_exact_rule_is_preferred_over_the_phrase_rule():
    """A page carrying one exact opener AND other sentence-shaped candidates resolves to the exact
    one, instead of collapsing to ambiguous and losing a composer it could name precisely."""
    hit = sp.opener_index_in_state(
        '[3]<button "Comment">\n[9]<button "Read or add comments 526 comments">')
    assert hit is not None and hit[0] == 3


def test_a_comment_task_must_not_click_create_new_post():
    """Measured live on instagram 2026-08-04, and caused by widening the opener match above.

    "New post Create" contains the phrase "new post", so a task that says "write a comment on the
    first post" matched Instagram's UPLOAD button. The run left the feed for a file picker and never
    saw a post, and nothing downstream could catch it: by then the only evidence left was a page
    with no composer on it, which reads as a missing composer rather than a wrong destination.

    Only the create-vs-respond direction is guarded. A respond-shaped label on a create task is left
    alone, because some sites really do route a new post through a control labelled "Write"."""
    ig = '[11]<button "New post Create">'
    assert sp.opener_index_in_state(ig, "write a comment on the first post") is None
    # the same button is exactly right when the task IS to create something new
    assert sp.opener_index_in_state(ig, "create a new post saying hi") is not None
    # and a genuine comment opener still resolves for the comment task
    assert sp.opener_index_in_state(
        '[11]<button "Read or add comments 526 comments">', "write a comment on the first post")


def test_omitting_the_task_leaves_opener_matching_exactly_as_it_was():
    """The task argument is optional so read-only callers (the perception summary line) keep their
    behaviour; a guard that changed what `opener=` reports would corrupt the dryrun report."""
    assert sp.opener_index_in_state('[11]<button "New post Create">') is not None
