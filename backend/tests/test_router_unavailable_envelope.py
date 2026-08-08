"""The router-down envelope must NAME the cause.

Found by the forced-failure battery on 2026-08-07: holding port 20128 with a dead socket so 9Router
could not rebind produced a real terminal failure whose envelope read `subkind=unclassified`, with a
breadcrumb trail that simply stopped after the prep phases. The cause was sitting in plain text in
`error_preview` ("9Router is not running; cannot use sonnet-cc") but nothing could be queried on it.
"""

import inspect

from backend.apps.agents.core.error_classify import is_router_unreachable_error
from backend.apps.agents.core.is_router_unavailable_error import is_router_unavailable_error
from backend.apps.agents.manager.run import handle_run_error


def test_the_verbatim_live_refusal_is_classified():
    # Exact string raised by configure_provider_env and captured in the battery envelope.
    assert is_router_unavailable_error(
        "9Router is not running; cannot use sonnet-cc. Install Node.js and restart the app, "
        "or switch to a model with a direct API key."
    )


def test_the_mid_turn_unreachable_shapes_still_qualify():
    for text in ("API Error: Unable to connect. Is the computer able to access the url?",
                 "fetch failed", "connect ECONNREFUSED 127.0.0.1:20128"):
        assert is_router_unavailable_error(text), text
        assert is_router_unreachable_error(text), "the narrower resume-path check must keep matching too"


def test_unrelated_failures_are_not_swallowed():
    for text in ("", "   ", "Prompt is too long", "Invalid API key",
                 "The router of the story is that nothing broke"):
        assert not is_router_unavailable_error(text), text


def test_the_rung_sits_above_unclassified():
    src = inspect.getsource(handle_run_error)
    assert "is_router_unavailable_error" in src
    assert src.index("is_router_unavailable_error") < src.index('p_report_model_error("unclassified"'), \
        "a router death must be named before the catch-all claims it"
    assert 'p_report_model_error("router_unavailable"' in src
