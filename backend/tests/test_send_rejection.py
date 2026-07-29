"""A cleared composer is not proof when the site just said no.

The whole fast write path rests on one signal: the payload left the composer. browser_send_script
has always carried the admission that this "cannot tell submitted from dismissed", guarded only for
guessed clicks and ghost-drop hosts. The realistic way it bites is neither: the site accepts the
click, clears the box, and pops "Something went wrong" or a rate limit. The receipt then reads as a
clean success and the agent tells the user it posted.

The guard reads only the page's live announcement regions (role=alert, aria-live), which is the
accessibility contract sites already follow, so it needs no per-site knowledge. It can only ever
DEMOTE a claim, never manufacture one, and it fails open: a broken probe returns "not rejected"
rather than inventing a failure that did not happen.
"""
import pytest

from backend.apps.agents.browser import browser_delivery_check as dc

REJECTIONS = [
    "Something went wrong. Try again.",
    "Couldn't post your reply",
    "Could not send message",
    "Unable to post right now",
    "Failed to send",
    "You've reached your daily limit. Try again later.",
    "Too many requests, please slow down",
    "Rate limit exceeded",
    "Your post wasn't sent",
    "An error occurred",
]

# A live region is also how sites announce SUCCESS and ordinary chatter. Matching these would turn
# every good send into a scary "it was rejected", which is a worse lie than the one being fixed.
NOT_REJECTIONS = [
    "Your post was sent.",
    "Posted",
    "Message sent",
    "Draft saved",
    "1 new notification",
    "Copied to clipboard",
    "",
    "   ",
]


def p_probe(text):
    """A fake BrowserEvaluate returning whatever the announcement regions supposedly held.

    Shape matters: parse_eval_value reads {"value": ...} at the TOP level. An earlier version of
    this fixture nested it one level deeper, which made every negative case pass for the wrong
    reason (unreadable result, not correct matching) while every positive case failed loudly."""
    async def run(tool, args, browser_id, tab_id):
        assert tool == "BrowserEvaluate"
        return {"value": {"text": text}}
    return run


@pytest.mark.asyncio
@pytest.mark.parametrize("text", REJECTIONS)
async def test_a_refusal_is_detected(text):
    assert await dc.send_rejected("b", "t", p_probe(text)) is True


@pytest.mark.asyncio
@pytest.mark.parametrize("text", NOT_REJECTIONS)
async def test_success_and_chatter_are_left_alone(text):
    assert await dc.send_rejected("b", "t", p_probe(text)) is False


@pytest.mark.asyncio
async def test_a_broken_probe_does_not_invent_a_failure():
    """Fail OPEN. Claiming rejection because we could not read the page would be the same class of
    lie in the other direction."""
    async def boom(tool, args, browser_id, tab_id):
        raise RuntimeError("evaluate died")
    assert await dc.send_rejected("b", "t", boom) is False


@pytest.mark.asyncio
async def test_a_hung_probe_does_not_block_the_send_path():
    """The probe sits on the irreversible path; it must time out rather than wedge the turn."""
    import asyncio

    async def hang(tool, args, browser_id, tab_id):
        await asyncio.sleep(30)
        return {}
    assert await dc.send_rejected("b", "t", hang) is False


@pytest.mark.asyncio
async def test_a_junk_shaped_result_is_not_a_rejection():
    async def junk(tool, args, browser_id, tab_id):
        return {"value": "not a dict"}
    assert await dc.send_rejected("b", "t", junk) is False


# --- the probe itself ------------------------------------------------------------------------

def test_the_probe_reads_only_announcement_regions():
    """Scope is the entire point. Whole-page text contains the word 'failed' on a huge fraction of
    the internet, and matching that would demote correct sends at random."""
    js = dc.rejection_probe_expression()
    assert "role=alert" in js
    assert "aria-live" in js
    assert "document.body" not in js, "the probe must not fall back to whole-page text"


def test_the_probe_bounds_what_it_returns():
    """An unbounded innerText from a chatty live region would bloat every send's payload."""
    assert "slice(0,600)" in dc.rejection_probe_expression()


# --- what the user is told -------------------------------------------------------------------

def test_the_rejection_note_states_plainly_that_it_did_not_send():
    note = dc.rejected_send_note("https://x.com/home", "hello there")
    assert "did NOT go through" in note
    assert "x.com" in note and "www." not in note
    assert "hello there" in note


def test_the_rejection_note_says_it_will_not_retry():
    """A blind retry on a refusal is how you get rate-limited harder, or post twice if the refusal
    was cosmetic."""
    assert "did not retry" in dc.rejected_send_note("https://x.com", "hi").lower()


def test_a_long_payload_is_clipped_in_the_note():
    note = dc.rejected_send_note("https://x.com", "y" * 500)
    assert "..." in note
    assert len(note) < 400


def test_the_rejection_note_is_distinct_from_the_unverified_one():
    """Different evidence, different claim. Collapsing them would either overclaim or send the user
    to go check something we already know."""
    rejected = dc.rejected_send_note("https://x.com", "hi")
    unverified = dc.unverified_send_note("https://x.com", "hi")
    assert rejected != unverified
    assert "could NOT confirm" in unverified
    assert "could NOT confirm" not in rejected
