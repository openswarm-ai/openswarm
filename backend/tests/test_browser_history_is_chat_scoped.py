"""A browser card's cached transcript belongs to the CHAT that produced it, never to the card alone.

ENG-403, production 1.7.9. A user asked for a Spotify playlist. The agent's private reasoning kept
insisting the task was "read everything under src/ (converters, server.js, logger, utils, doc.md)
and give observations" -- a code review nobody asked for -- verbatim, turn after turn, while every
tool call was a Spotify browser action. Haik on why it is severity 1:

    "I only caught it because the phantom task and my real actions openly contradicted each other.
     If they'd been even loosely compatible, I'd have quietly done the wrong thing and reported
     success."

`BROWSER_HISTORY` was keyed by browser_id with no session identity at all, and a card outlives the
chat that opened it. "Stable across turns" was the tell: a race drifts, a cache repeats.
"""

import pytest

from backend.apps.agents.browser import browser_history as h

PHANTOM = [{"role": "user", "content": "read everything under src/ and give observations"}]


@pytest.fixture(autouse=True)
def p_clean_store():
    h.BROWSER_HISTORY.clear()
    h.HISTORY_OWNER.clear()
    yield
    h.BROWSER_HISTORY.clear()
    h.HISTORY_OWNER.clear()


def test_a_chat_resumes_its_own_work_on_a_card():
    # The whole point of the cache: a follow-up must not re-orient from a screenshot.
    h.remember_history("card1", "chat-code-review", PHANTOM)
    assert h.resume_history("card1", "chat-code-review") == PHANTOM


def test_the_next_chat_to_use_that_card_starts_clean():
    h.remember_history("card1", "chat-code-review", PHANTOM)
    assert h.resume_history("card1", "chat-spotify") == []


def test_a_transcript_with_no_owner_is_never_cached():
    # An unowned entry is precisely what a later chat reads as its own past.
    h.remember_history("card2", None, PHANTOM)
    assert "card2" not in h.BROWSER_HISTORY
    assert h.resume_history("card2", "chat-spotify") == []


def test_closing_a_card_forgets_who_owned_it():
    h.remember_history("card1", "chat-a", PHANTOM)
    h.clear_browser_history("card1")
    assert "card1" not in h.HISTORY_OWNER, "a stale owner would let a recycled id resume"
    assert h.resume_history("card1", "chat-a") == []


def test_nothing_reaches_into_the_store_behind_the_accessors():
    # The module's own docstring already claimed this ("all reads and writes route through here");
    # browser_agent.py reached into the dict directly, which is how the key stayed card-only.
    src = open("backend/apps/agents/browser/browser_agent.py").read()
    assert "BROWSER_HISTORY" not in src
    assert "resume_history(browser_id, parent_session_id)" in src
    assert "remember_history(" in src


def test_the_owner_is_the_CHAT_not_the_sub_agent():
    # A browser sub-agent session is created per dispatch, so keying on it would make resume never
    # fire: the feature would be silently dead rather than merely scoped.
    src = open("backend/apps/agents/browser/browser_agent.py").read()
    i = src.index("prior_messages = browser_history.resume_history(")
    assert "parent_session_id" in src[i:i + 120]
