"""The CLI hands the filter's verdict back as prose, and it used to be stored as the model's words.

Production 1.7.9, 2026-08-26: sub-agents came home with
"Claude Code is unable to respond to this request, which appears to violate our Usage Policy" as
their ANSWER. There is no "API Error:" prefix and no status code in it, so every envelope check in
the codebase said "this is the agent talking" and the refusal became transcript content: the parent
then carried policy-violation language into every later request (the exact class CLAUDE.md forbids).

Two separate misses, both sealed here: the wording ("Usage Policy", not "Acceptable Use Policy") and
the shape (prose, not an envelope).
"""

import re

from backend.apps.agents.core.error_classify import (
    is_content_policy_block, neutralize_provider_refusal, opens_with_provider_refusal,
)
from backend.apps.agents.manager.streaming.provider_error_speech import (
    POLICY, classify_provider_error, looks_like_provider_envelope,
)

REAL = ("Claude Code is unable to respond to this request, which appears to violate our Usage Policy "
        "(https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or "
        "start a new session for a fresh start.")


def test_the_clis_own_wording_is_recognised_without_the_url():
    # It only ever matched via "legal/aup" in the URL, so a truncated preview read as a clean turn.
    assert is_content_policy_block("appears to violate our Usage Policy.")
    assert is_content_policy_block("violates our Acceptable Use Policy")
    assert is_content_policy_block("reverse engineering or duplicating model outputs")


def test_prose_with_no_envelope_is_still_the_provider_talking():
    assert "API Error" not in REAL and not re.search(r"\b4\d\d\b", REAL)
    assert opens_with_provider_refusal(REAL)
    assert looks_like_provider_envelope(REAL)
    c = classify_provider_error(REAL)
    assert c is not None and c.kind == POLICY


def test_the_refusal_never_travels_home_as_a_delegated_answer():
    out = neutralize_provider_refusal(REAL)
    assert out != REAL
    assert "Usage Policy" not in out and "violate" not in out


def test_a_real_answer_that_discusses_policy_keeps_every_word():
    # The innocent case: this is what an agent asked to summarise a terms page actually returns.
    innocent = ("Their Acceptable Use Policy forbids reverse engineering. Section 3 also bans "
                "duplicating model outputs, and accounts may be suspended for it.")
    assert neutralize_provider_refusal(innocent) == innocent
    assert classify_provider_error(innocent) is None


def test_the_refusal_must_OPEN_the_message_to_count():
    # A long real answer that quotes the refusal late is work, not a refusal; eating it would be
    # silent work loss, which is worse than the bug this guard exists for.
    embedded = ("Here is what I found across the three pages you asked about, with the quotas and "
                "the pricing table reproduced below in full detail for each tier of the plan. "
                "One page did say it is unable to respond to this request, which appears to "
                "violate our Usage Policy, so I skipped it.")
    assert not opens_with_provider_refusal(embedded)
    assert neutralize_provider_refusal(embedded) == embedded


def test_the_model_refusing_on_its_own_is_not_scored_as_a_policy_block():
    # No policy wording at all, so it stays the agent's own speech.
    own = "I'm unable to respond to this request because the file you named does not exist."
    assert not opens_with_provider_refusal(own)
    assert classify_provider_error(own) is None
