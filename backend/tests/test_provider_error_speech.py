"""Every positive case here is a string this machine actually produced.

VERIFICATION.md section 3: "a probe that invents its own inputs measures the probe." So the
envelopes below were lifted verbatim out of backend/data/sessions rather than written from memory
of what a 429 "should" look like -- an invented pattern would have tested my imagination and passed
while the real Gemini string sailed through.

The negative controls carry the weight. A classifier that swallows anything mentioning a status code
would score 14/14 here and silently delete the agent's ability to discuss an error it saw in a log,
which is section 5b's "a fix that REMOVES a capability is not a fix either."
"""

import pytest

from backend.apps.agents.manager.streaming.provider_error_speech import (
    AUTH,
    CONNECTION,
    OVERLOADED,
    QUOTA,
    classify_provider_error,
    is_transient,
    looks_like_provider_envelope,
    parse_duration,
    user_facing_sentence,
)

# --- verbatim from backend/data/sessions on 2026-08-20 -------------------------------------------

REAL_GEMINI_QUOTA_LONG = (
    "API Error: Request rejected (429) · [antigravity/gemini-3-flash] [429]: Individual quota "
    "reached. Please upgrade your subscription to increase your limits. Resets in 125h40m51s. "
    "(reset after 2m)"
)
REAL_GEMINI_QUOTA_NO_WINDOW = (
    "API Error: Request rejected (429) · [antigravity/gemini-3-flash] [429]: Individual quota "
    "reached. Please upgrade your subscription to increase your limits. Resets in "
    "(reset after 1m 56s)"
)
REAL_CLAUDE_CONNECTION = "API Error: Unable to connect. Is the computer able to access the url?"

REAL_ENVELOPES = [REAL_GEMINI_QUOTA_LONG, REAL_GEMINI_QUOTA_NO_WINDOW, REAL_CLAUDE_CONNECTION]


# --- the class is recognised ---------------------------------------------------------------------

@pytest.mark.parametrize("raw", REAL_ENVELOPES)
def test_every_real_envelope_is_recognised(raw):
    assert looks_like_provider_envelope(raw)
    assert classify_provider_error(raw) is not None


def test_gemini_quota_reports_status_lane_and_window():
    err = classify_provider_error(REAL_GEMINI_QUOTA_LONG)
    assert err.kind == QUOTA
    assert err.status == 429
    assert err.lane == "antigravity"
    # 125h40m51s, which is the number the user actually has to plan around.
    assert err.reset_seconds == 125 * 3600 + 40 * 60 + 51


def test_claude_connection_error_has_no_status_and_still_classifies():
    err = classify_provider_error(REAL_CLAUDE_CONNECTION)
    assert err.kind == CONNECTION
    assert err.status is None


def test_auth_and_overload_statuses_route_by_code_not_wording():
    # Status is the provider's own verdict; wording varies per lane and must not be load-bearing.
    assert classify_provider_error("API Error: [codex/gpt-5] [401]: nope").kind == AUTH
    assert classify_provider_error("API Error: [cc/sonnet-5] [529]: overloaded").kind == OVERLOADED


# --- the negative controls: agent speech must survive ---------------------------------------------

AGENT_PROSE = [
    "I checked the logs and the server returned a 429, so I backed off and retried once.",
    "The API Error you saw earlier was a rate limit; here is what I changed.",
    "Summary: 3 requests failed with 500 and 2 with 403. I've added a retry.",
    "Your test asserts a 401 response, and that assertion is correct.",
    "```\nAPI Error: Request rejected (429)\n```\nThat's the line from your log file.",
]


@pytest.mark.parametrize("prose", AGENT_PROSE)
def test_agent_discussing_an_error_is_still_the_agent(prose):
    """If this ever fails, the agent has lost the ability to talk about errors at all."""
    assert not looks_like_provider_envelope(prose)
    assert classify_provider_error(prose) is None


def test_empty_and_whitespace_are_not_envelopes():
    assert classify_provider_error("") is None
    assert classify_provider_error("   \n  ") is None


# --- what the user is told -------------------------------------------------------------------------

def test_long_quota_tells_the_user_to_switch_rather_than_wait():
    err = classify_provider_error(REAL_GEMINI_QUOTA_LONG)
    sentence = user_facing_sentence(err, "gemini-3.1-flash-lite")
    assert "Gemini" in sentence
    assert "switch" in sentence.lower()
    # A five-day wait must never be presented as something to sit through.
    assert not is_transient(err)


def test_short_rate_limit_promises_automatic_resume():
    err = classify_provider_error(
        "API Error: Request rejected (429) · [antigravity/gemini-3-flash] [429]: slow down. "
        "(reset after 2m)"
    )
    assert is_transient(err)
    sentence = user_facing_sentence(err, "gemini-3.1-flash-lite")
    assert "automatically" in sentence.lower()


def test_no_sentence_leaks_provider_jargon():
    """The whole point: the user never reads a status code or a vendor's upgrade pitch."""
    for raw in REAL_ENVELOPES:
        err = classify_provider_error(raw)
        sentence = user_facing_sentence(err, "sonnet-5")
        assert "429" not in sentence
        assert "API Error" not in sentence
        assert "upgrade your subscription" not in sentence.lower()
        assert sentence.strip().endswith(".")


def test_connection_loss_is_transient_so_the_turn_can_park():
    err = classify_provider_error(REAL_CLAUDE_CONNECTION)
    assert is_transient(err)


# --- duration parsing, because the window decides park-vs-tell -------------------------------------

@pytest.mark.parametrize("blob,expected", [
    ("125h40m51s", 125 * 3600 + 40 * 60 + 51),
    ("1m 56s", 116),
    ("2m", 120),
    ("45s", 45),
])
def test_duration_parsing(blob, expected):
    assert parse_duration(blob) == expected


def test_unparseable_duration_is_none_not_zero():
    """Zero would read as 'resume immediately', which is the opposite of what an unknown means."""
    assert parse_duration("soon") is None


def test_policy_refusal_is_its_own_kind_and_never_promises_a_retry():
    """Alex read 'Retrying automatically' before every bricked turn; nothing retried. The 400 with
    the policy verdict in words must classify as POLICY ahead of its status, and the unknown-error
    sentence must stop promising a retry it does not queue."""
    from backend.apps.agents.manager.streaming.provider_error_speech import POLICY, UNKNOWN
    raw = ("API Error: 400 https://www.anthropic.com/legal/aup). This request was blocked as it seems "
           "to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs.")
    err = classify_provider_error(raw)
    assert err is not None and err.kind == POLICY
    assert is_transient(err) is False
    assert "policy filter" in user_facing_sentence(err, "opus-5")
    unknown = classify_provider_error("API Error: 400 something nobody classified")
    assert unknown is not None and unknown.kind == UNKNOWN
    assert "Retrying automatically" not in user_facing_sentence(unknown, "opus-5")
