"""Open the first item of the kind the task named, without asking a model to find it.

"Comment on the first post" is a RESPOND task, so the compose-URL table (which answers "where do I
CREATE one of these?") does not apply and the aux navigator has to find the item by clicking around a
feed. Measured on instagram across four windows: 1/10, 3/5, 0/5, 0/5, landing variously in the
stories viewer, on a profile, or nowhere, because a feed's first clickable thing is not reliably a
post.

But a site publishes what each link IS, in the link's own URL: instagram posts at /p/, tiktok videos
at /video/, youtube at /watch. Picking the first match is deterministic where a model is not.

The rules exist to stop it firing when a positional pick would be WRONG, which is the only way this
tier can hurt: it navigates, and navigating away from the right page costs the run.
"""

from backend.apps.agents.browser import first_item_of_type as fit


def test_an_ordinal_plus_one_content_type_qualifies():
    assert fit.wanted_type("write a comment on the first post") == "post"
    assert fit.wanted_type("comment on the first video") == "video"
    assert fit.wanted_type("reply to the top story") == "story"


def test_a_named_target_is_never_a_positional_pick():
    """"reply to Sarah's message" names WHICH one. Opening "the first message" would answer the
    wrong person, which is the same family as the DM incident this codebase already has scars from."""
    assert fit.wanted_type("reply to Sarah's message") is None
    assert fit.wanted_type("comment on the post about rust") is None


def test_no_content_type_named_means_no_pick():
    assert fit.wanted_type("post this tweet") is None
    assert fit.wanted_type("send hi to charles") is None


def test_two_content_types_stay_ambiguous():
    """A task naming two kinds gives no basis for choosing which to open first."""
    assert fit.wanted_type("reply to the first story on that post") is None
    assert fit.wanted_type("comment on the first video or post") is None


def test_the_link_search_is_same_origin_only():
    """A feed is full of outbound links and ads. Following one turns "comment on the first post"
    into a visit to whatever an advertiser paid for."""
    expr = fit.first_link_expression("post")
    assert "u.origin !== location.origin" in expr, "must refuse cross-origin links"
    assert "querySelectorAll('a[href]')" in expr


def test_each_type_gets_the_shape_that_site_family_actually_uses():
    assert "/(p|posts?|status)/" in fit.first_link_expression("post")      # instagram, mastodon
    assert "/(watch|shorts)" in fit.first_link_expression("video")          # youtube
    assert "/video/" in fit.first_link_expression("video")                  # tiktok
    assert "/stories?/" in fit.first_link_expression("story")


def test_an_unknown_type_yields_no_expression_rather_than_a_broken_one():
    """No expression means the tier stands down and the aux navigator runs, i.e. today's behaviour."""
    assert fit.first_link_expression("banana") == ""
    assert fit.first_link_expression("") == ""
