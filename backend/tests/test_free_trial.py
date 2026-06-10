"""Free-trial dispatch injection: the pure-logic pieces that decide routing."""

import backend  # noqa: F401  (path sanity asserted below)

from backend.apps.settings.models import AppSettings
from backend.apps.settings.credentials import proxy_auth
from backend.apps.agents.core.error_classify import (
    _is_free_trial_exhausted,
    _is_transient_capacity_error,
)
from backend.apps.agents.providers.registry import resolve_model_id_for_sdk
from backend.apps.subscription.free_trial import _has_own_model


def test_proxy_auth_for_each_mode():
    assert proxy_auth(AppSettings()) == (None, None)

    pro = AppSettings(
        connection_mode="openswarm-pro",
        openswarm_bearer_token="bear",
        openswarm_proxy_url="https://api.openswarm.com",
    )
    assert proxy_auth(pro) == ("bear", "https://api.openswarm.com")

    free = AppSettings(
        connection_mode="free-trial",
        free_trial_token="ftk",
        openswarm_proxy_url="https://api.openswarm.com",
    )
    # Free-trial carries the /free segment so the same SDK lands on the metered route.
    assert proxy_auth(free) == ("ftk", "https://api.openswarm.com/free")


def test_free_trial_resolves_to_a_bare_anthropic_id():
    s = AppSettings(connection_mode="free-trial", free_trial_token="ftk")
    mid = resolve_model_id_for_sdk("sonnet", s)
    # The bug this fixes: without the free-trial branch this returns a cc/-prefixed
    # id that 401s when no Claude subscription is connected.
    assert "cc/" not in mid
    assert mid.startswith("claude-")


def test_exhaustion_is_classified_and_not_retried():
    assert _is_free_trial_exhausted(Exception("error type free_trial_exhausted"))
    assert _is_free_trial_exhausted(Exception("You've used your free OpenSwarm runs"))
    assert not _is_free_trial_exhausted(Exception("overloaded, try again"))
    # Must NOT look transient, or the agent loop would retry a spent trial forever.
    assert not _is_transient_capacity_error(Exception("free_trial_exhausted"))


def test_has_own_model_never_shadows_a_real_provider():
    assert not _has_own_model(AppSettings(connection_mode="free-trial", free_trial_token="x"))
    assert not _has_own_model(AppSettings())
    assert _has_own_model(AppSettings(anthropic_api_key="sk-ant-x"))
    assert _has_own_model(
        AppSettings(connection_mode="openswarm-pro", openswarm_bearer_token="b")
    )
