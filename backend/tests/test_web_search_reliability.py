"""WebSearch path reliability: subscription OAuth must fall back to DuckDuckGo.

The 401 'Invalid bearer token (reset after 2m)' the user hit comes from the CLI's
built-in WebSearch delegating to Haiku via a subscription's rotating OAuth token.
So a subscription-OAuth-only user must NOT be treated as having a reliable hosted
search path, they keep the free, always-working DDG fallback instead.
"""

from backend.apps.agents.tools.web import anthropic_web_search_is_reliable as ok


def test_direct_api_key_is_reliable():
    assert ok(has_direct_anthropic_key=True, is_pro=False, provider_ids=[]) is True


def test_pro_is_reliable():
    assert ok(has_direct_anthropic_key=False, is_pro=True, provider_ids=[]) is True


def test_direct_anthropic_9router_provider_is_reliable():
    assert ok(has_direct_anthropic_key=False, is_pro=False, provider_ids=["anthropic"]) is True


def test_subscription_oauth_only_is_NOT_reliable():
    # the bug: this used to count as reliable -> suppressed DDG -> 401s on rotation
    assert ok(has_direct_anthropic_key=False, is_pro=False, provider_ids=["claude"]) is False
    assert ok(has_direct_anthropic_key=False, is_pro=False, provider_ids=["claude-code"]) is False
    assert ok(has_direct_anthropic_key=False, is_pro=False, provider_ids=["claude", "claude-code"]) is False


def test_nothing_is_not_reliable():
    assert ok(has_direct_anthropic_key=False, is_pro=False, provider_ids=[]) is False
    assert ok(has_direct_anthropic_key=False, is_pro=False, provider_ids=None) is False


def test_mixed_subscription_plus_direct_is_reliable():
    # if the user ALSO has a stable direct anthropic connection, hosted search is fine
    assert ok(has_direct_anthropic_key=False, is_pro=False,
              provider_ids=["claude", "anthropic"]) is True
