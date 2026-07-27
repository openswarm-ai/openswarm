"""Soft signed-out detection, plus the two invariants behind the 2026-07-26 bug hunt.

Each test here corresponds to a bug that actually escaped to a live run, so the point is to make
that whole CLASS unwritable rather than to re-check a line:

  1. Sites that browse fine while withholding the composer (bsky/stackoverflow/tiktok/threads) hit
     no login URL and show no password field, so the hard-wall gate saw nothing and the run
     reported "couldn't find the compose box" when the truth was "you are not signed in".
  2. The composer finder budgeted ~24s of reveal work into a 15s command timeout, so heavy pages
     were killed mid-ladder and threw away everything, and the last two tiers were unreachable.
"""
import os
import re

from backend.apps.agents.browser import browser_send_parse as sp
from backend.apps.agents.browser import browser_login_handoff as lh
from backend.apps.agents.core.ws_manager import BROWSER_CMD_TIMEOUTS, BROWSER_CMD_TIMEOUT_DEFAULT

P_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P_HANDLER_TS = os.path.join(P_REPO_ROOT, "frontend", "src", "shared", "browserCommandHandler.ts")

# Page-shaped perceptions, in the interactives format the agent actually sees.
BSKY_SIGNED_OUT = '[1]<link "Sign in">\n[2]<button "Create account">\n[3]<heading "Discover">'
SO_SIGNED_OUT = '[4]<link "Log in">\n[5]<link "Sign up">\n[6]<heading "Questions">'
X_SIGNED_IN = '[1]<button "Profile">\n[2]<textbox "What is happening?">\n[9]<button "Post">'
# A signed-IN page that still advertises a sign-up somewhere: the veto must win, or we would tell
# an authenticated user to log in again.
SIGNED_IN_WITH_PROMO = '[1]<link "Sign up">\n[2]<button "Sign out">\n[3]<textbox "Post text">'
LINKEDIN_FEED = '[1]<button "Start a post">\n[2]<link "Notifications">\n[3]<link "My Network">'


def test_soft_signed_out_pages_are_detected():
    assert sp.looks_signed_out(BSKY_SIGNED_OUT)
    assert sp.looks_signed_out(SO_SIGNED_OUT)


def test_signed_in_pages_are_never_called_signed_out():
    for state in (X_SIGNED_IN, SIGNED_IN_WITH_PROMO, LINKEDIN_FEED, ""):
        assert not sp.looks_signed_out(state), state[:40]


def test_signed_in_marker_vetoes_a_sign_in_link():
    """The whole point of the veto: 'Sign up' present AND 'Sign out' present means signed IN."""
    assert not sp.looks_signed_out(SIGNED_IN_WITH_PROMO)


def test_soft_detection_is_separate_from_the_hard_wall():
    """A soft page must NOT read as a hard login wall: the hard gate declines the send outright,
    and mislabelling here would change behaviour on pages we can still act on."""
    assert not sp.looks_like_login_wall("https://bsky.app/", BSKY_SIGNED_OUT)
    assert sp.looks_signed_out(BSKY_SIGNED_OUT)


def test_handoff_ignores_soft_pages_unless_explicitly_allowed():
    """allow_soft is off by default because the pause interrupts the user; the caller turns it on
    only once the agent is demonstrably stuck."""
    assert lh.login_wall_domain("https://bsky.app/", BSKY_SIGNED_OUT) is None
    assert lh.login_wall_domain("https://bsky.app/", BSKY_SIGNED_OUT, allow_soft=True) == "bsky.app"


def test_handoff_still_catches_hard_walls_without_soft():
    assert lh.login_wall_domain("https://www.instagram.com/accounts/login/", "") == "instagram.com"


def test_find_composer_timeout_exceeds_its_own_in_page_budget():
    """INVARIANT that seals the linkedin bug: the reveal ladder self-caps at a deadline, and the
    command carrying it must outlast that deadline. If someone lowers the timeout (or raises the
    in-page budget) past each other, heavy pages silently die mid-ladder again."""
    budget_ms = p_in_page_budget_ms()
    timeout_s = BROWSER_CMD_TIMEOUTS.get("find_composer", BROWSER_CMD_TIMEOUT_DEFAULT)
    assert timeout_s * 1000 > budget_ms, (
        f"find_composer timeout {timeout_s}s must exceed the in-page deadline {budget_ms}ms")


def p_in_page_budget_ms() -> int:
    """The deadline the in-page finder gives itself, read from the renderer source so the two sides
    of the invariant can never drift apart silently."""
    with open(P_HANDLER_TS, encoding="utf-8") as fh:
        src = fh.read()
    m = re.search(r"const DEADLINE = Date\.now\(\) \+ (\d+)", src)
    assert m, "in-page finder deadline not found; did the reveal ladder change?"
    return int(m.group(1))
