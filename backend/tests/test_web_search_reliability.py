"""Built-in WebSearch reliability: only an ENTITLED Anthropic endpoint suppresses DDG.

The 401 'Invalid bearer token (reset after ~2m)' comes from the CLI's built-in
WebSearch firing an aux `claude-haiku` call. That call only authenticates when it
reaches an entitled Anthropic endpoint:
  - a DIRECT anthropic api-route model (base_url = api.anthropic.com, user's key), or
  - OpenSwarm Pro (entitled to the managed pool 9Router's anthropic/* resolves to).

A SUBSCRIPTION-route Claude model (opus-4-8, route=None) sends the haiku call
through 9Router to the managed pool, which 401s for non-Pro users, so a bare
anthropic_api_key in settings is NOT enough. Those sessions must keep the free,
always-working DDG fallback instead of a 401-ing hosted path.
"""

from backend.apps.agents.tools.web import anthropic_web_search_is_reliable as ok


def test_direct_anthropic_api_route_is_reliable():
    # opus-4-8-api (route='api', api='anthropic') + key in settings -> direct, works
    assert ok(uses_direct_anthropic_api=True, is_pro=False) is True


def test_openswarm_pro_is_reliable():
    assert ok(uses_direct_anthropic_api=False, is_pro=True) is True


def test_both_is_reliable():
    assert ok(uses_direct_anthropic_api=True, is_pro=True) is True


def test_subscription_route_claude_is_NOT_reliable():
    # The exact bug: opus-4-8 (subscription route) + key in settings. The haiku call still 401s via the managed pool, so this must stay unreliable -> DDG.
    assert ok(uses_direct_anthropic_api=False, is_pro=False) is False
