"""A check that could not observe must say "unknown", never "no".

This bug class cost most of a night. The identical shape appeared in three places, and in every one
it manufactured a confident false answer:

  1. the send receipt      a cleared composer was read as delivered even when the site had refused
  2. the campaign verifier a verify turn that could not reach the profile scored the post "not landed"
  3. the cleanup accounting a recheck that could not read the page scored the post "deleted"

(3) is the one that did real damage: it reported a clean account while six test posts sat live on
it, twice. All three are the same mistake, absence of evidence recorded as evidence of absence, and
patching them one at a time is treating symptoms.

The rule, and what this file pins:

  - An observation returns True / False / None, where None means the observation did not happen.
  - Collapsing None is allowed in exactly one direction: when deciding whether to CLAIM something,
    unknown must behave as "do not claim". Withholding an uncertain claim is safe; asserting a
    negative from a failed look is not.
"""
import asyncio

import pytest

from backend.apps.agents.browser import browser_delivery_check as dc


def p_eval(value):
    async def run(tool, args, browser_id, tab_id):
        return {"value": value}
    return run


async def p_boom(tool, args, browser_id, tab_id):
    raise RuntimeError("probe died")


async def p_hang(tool, args, browser_id, tab_id):
    await asyncio.sleep(30)
    return {}


# --- payload_visible is a three-valued observation -------------------------------------------

@pytest.mark.asyncio
async def test_seen_is_true():
    assert await dc.payload_visible("hi", "b", "t", p_eval({"visible": True})) is True


@pytest.mark.asyncio
async def test_looked_and_absent_is_false():
    """The genuine negative: the probe ran and the text is not on the page."""
    assert await dc.payload_visible("hi", "b", "t", p_eval({"visible": False})) is False


@pytest.mark.asyncio
async def test_a_failed_probe_is_unknown_not_absent():
    """The regression. Returning False here tells the user a post did not land when nobody looked."""
    assert await dc.payload_visible("hi", "b", "t", p_boom) is None


@pytest.mark.asyncio
async def test_a_hung_probe_is_unknown():
    assert await dc.payload_visible("hi", "b", "t", p_hang) is None


@pytest.mark.asyncio
async def test_an_unreadable_shape_is_unknown():
    """A dict without the key is not a negative answer; it is a broken answer."""
    assert await dc.payload_visible("hi", "b", "t", p_eval({"nope": 1})) is None
    assert await dc.payload_visible("hi", "b", "t", p_eval("garbage")) is None


# --- the one legitimate collapse: do not CLAIM on unknown ------------------------------------

@pytest.mark.asyncio
async def test_ghost_confirmation_refuses_to_claim_on_unknown():
    """Deciding whether to assert a delivery: unknown must behave as "do not assert"."""
    assert await dc.ghost_delivery_confirmed("hi", "b", "t", p_boom) is False


@pytest.mark.asyncio
async def test_ghost_confirmation_still_confirms_a_real_survival():
    assert await dc.ghost_delivery_confirmed("hi", "b", "t", p_eval({"visible": True})) is True


@pytest.mark.asyncio
async def test_ghost_confirmation_returns_a_hard_bool():
    """Its contract is binary by design (claim / do not claim); leaking a None here would make an
    unknown look like a confirmed delivery to any `if` further up."""
    for probe in (p_boom, p_eval({"visible": True}), p_eval({"visible": False})):
        got = await dc.ghost_delivery_confirmed("hi", "b", "t", probe)
        assert got is True or got is False


# --- the rejection probe collapses the other way, and that is also correct --------------------

@pytest.mark.asyncio
async def test_a_broken_rejection_probe_does_not_invent_a_refusal():
    """Mirror image: send_rejected decides whether to assert a FAILURE, so unknown must behave as
    "do not assert" there too. Same rule, opposite polarity, because the claim is inverted."""
    assert await dc.send_rejected("b", "t", p_boom) is False


@pytest.mark.asyncio
async def test_the_send_script_distinguishes_absent_from_unlooked():
    """The caller must branch on `is False` / `is None`, not truthiness. `if not delivered` treats
    an unknown exactly like a proven absence, which is the bug this whole file exists for."""
    src = dc.__file__.replace("browser_delivery_check.py", "browser_send_script.py")
    with open(src) as f:
        text = f.read()
    assert "delivered is False" in text
    assert "delivered is None" in text
    assert "if not delivered:" not in text, "truthiness collapses unknown into absent"
