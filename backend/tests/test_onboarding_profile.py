"""Onboarding profiling: parse + fail-open behavior. The live scoped-agent read is not covered here
(it needs a connected Google account); these lock the parsing and the always-degrade-to-floor paths."""

import asyncio

from backend.apps.agents.onboarding_profile import p_extract_json, p_parse_profile, profile_user


def test_parse_fenced_reply_with_prose():
    text = (
        "Here's what I found.\n```json\n"
        '{"observation": "A few invoices are overdue and your week is busy.", '
        '"options": [{"label": "Chase invoices", "prompt": "Find overdue invoices and draft follow-ups."}]}'
        "\n```\nHope that helps!"
    )
    result = p_parse_profile(text)
    assert result is not None
    assert result.observation == "A few invoices are overdue and your week is busy."
    assert len(result.options) == 1
    assert result.options[0].label == "Chase invoices"


def test_parse_takes_last_json_object():
    text = '{"observation":"old"} then the real one {"observation":"new","options":[]}'
    result = p_parse_profile(text)
    assert result is not None
    assert result.observation == "new"


def test_parse_garbage_is_none():
    assert p_parse_profile("no json in here at all") is None
    assert p_extract_json("") is None


def test_parse_empty_observation_kept_as_silent():
    result = p_parse_profile('{"observation":"","options":[]}')
    assert result is not None
    assert result.observation == ""
    assert result.options == []


def test_parse_wrong_shape_is_none():
    assert p_parse_profile('{"observation": 5, "options": "nope"}') is None


def test_profile_user_no_consent_returns_none():
    assert asyncio.run(profile_user("Eric", False)) is None


def test_profile_user_no_connected_google_returns_none():
    # No Google connector connected+enabled in the test env -> fail open to the floor.
    assert asyncio.run(profile_user("Eric", True)) is None
