"""Free-trial dispatch injection: the pure-logic pieces that decide routing."""

import backend  # noqa: F401  (path sanity asserted below)

import pytest

from backend.apps.settings.models import AppSettings
from backend.apps.settings.credentials import proxy_auth
from backend.apps.agents.core.error_classify import (
    is_free_trial_exhausted,
    is_transient_capacity_error,
)
from backend.apps.agents.providers.registry import resolve_model_id_for_sdk
from backend.apps.subscription import free_trial as ft
from backend.apps.subscription.free_trial import has_own_model, arm_free_trial, clear_free_trial


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
    # The bug this fixes: without the free-trial branch this returns a cc/-prefixed id that 401s when no Claude subscription is connected.
    assert "cc/" not in mid
    assert mid.startswith("claude-")


def test_exhaustion_is_classified_and_not_retried():
    assert is_free_trial_exhausted(Exception("error type free_trial_exhausted"))
    assert is_free_trial_exhausted(Exception("You've used your free OpenSwarm runs"))
    assert not is_free_trial_exhausted(Exception("overloaded, try again"))
    # Must NOT look transient, or the agent loop would retry a spent trial forever.
    assert not is_transient_capacity_error(Exception("free_trial_exhausted"))


def test_generic_cli_failure_uses_sdk_system_events_for_rate_limits():
    system_event_tail = (
        '{"subtype":"api_retry","data":{"error_status":429,'
        '"error":"rate_limit","max_retries":10}}'
    )
    assert is_transient_capacity_error(
        Exception("Command failed with exit code 1"),
        extra_text=system_event_tail,
    )


def testhas_own_model_never_shadows_a_real_provider():
    assert not has_own_model(AppSettings(connection_mode="free-trial", free_trial_token="x"))
    assert not has_own_model(AppSettings())
    assert has_own_model(AppSettings(anthropic_api_key="sk-ant-x"))
    assert has_own_model(
        AppSettings(connection_mode="openswarm-pro", openswarm_bearer_token="b")
    )


@pytest.mark.asyncio
async def test_arm_waits_for_9router_before_shadowing_a_background_started_sub(monkeypatch):
    """The regression: 9Router starts in the background, so at first-boot mint time
    a real Claude sub is invisible. arm() must bring 9Router up (so the sub becomes
    visible) BEFORE deciding, instead of arming the free trial over it."""
    saved: list = []
    monkeypatch.setattr(ft, "save_settings_async", _record(saved))
    monkeypatch.setattr(ft, "p_sync_routing", _noop)

    started = {"called": False}

    async def fake_ensure_running():
        started["called"] = True  # 9Router comes up here; the sub is now visible

    # The sub is only reachable AFTER ensure_running ran (mirrors the real race).
    async def sub_visible_after_start():
        return started["called"]

    import backend.apps.nine_router as nr
    monkeypatch.setattr(nr, "ensure_running", fake_ensure_running)
    monkeypatch.setattr(ft, "p_has_connected_subscription", sub_visible_after_start)

    s = AppSettings()  # no key, own_key mode: a subscription-only user
    out = await arm_free_trial(s)

    assert started["called"], "arm must start 9Router before trusting the sub check"
    assert out["armed"] is False and out["reason"] == "has_model"
    assert s.connection_mode == "own_key"
    assert s.default_model != "haiku"


@pytest.mark.asyncio
async def test_arm_tolerates_provider_load_lag(monkeypatch):
    """9Router's /api/providers can lag is_running on a cold start. arm must re-check
    a few times so a sub that loads a beat late is still caught, not shadowed."""
    monkeypatch.setattr(ft, "save_settings_async", _noop)
    monkeypatch.setattr(ft, "p_sync_routing", _noop)

    async def fake_ensure_running():
        return None

    calls = {"n": 0}
    async def lagging_sub():
        calls["n"] += 1
        return calls["n"] >= 3  # empty for the first two probes, then the sub appears

    import backend.apps.nine_router as nr
    monkeypatch.setattr(nr, "ensure_running", fake_ensure_running)
    monkeypatch.setattr(ft, "p_has_connected_subscription", lagging_sub)

    s = AppSettings()
    res = await ft.arm_free_trial(s)
    assert res["reason"] == "has_model", res
    assert s.default_model != "haiku"
    assert calls["n"] >= 3, "should have re-checked past the lagging-empty probes"


@pytest.mark.asyncio
async def test_arm_with_no_sub_is_bounded_and_falls_through_to_arm(monkeypatch):
    """The 'don't poll for something that doesn't exist' guarantee: a genuinely
    sub-less user must exhaust the re-checks quickly and PROCEED to arm, never hang."""
    async def fake_ensure_running():
        return None
    async def never_sub():
        return False

    import time
    import backend.apps.nine_router as nr
    monkeypatch.setattr(nr, "ensure_running", fake_ensure_running)
    monkeypatch.setattr(ft, "p_has_connected_subscription", never_sub)
    # Short-circuit before the cloud mint so the test stays offline + deterministic; reaching this branch proves arm did NOT falsely conclude has_model.
    monkeypatch.setattr(ft, "p_fingerprint", lambda _s: None)

    s = AppSettings()
    t = time.monotonic()
    res = await ft.arm_free_trial(s)
    elapsed = time.monotonic() - t
    assert res["reason"] == "no_fingerprint", res  # got past the sub guard to the arm path
    assert elapsed < 3.0, f"re-check budget not bounded: {elapsed:.2f}s"


@pytest.mark.asyncio
async def test_clear_reverts_forced_haiku_so_it_doesnt_outlive_the_trial(monkeypatch):
    monkeypatch.setattr(ft, "save_settings_async", _noop)
    monkeypatch.setattr(ft, "p_sync_routing", _noop)

    s = AppSettings(connection_mode="free-trial", free_trial_token="ftk", default_model="haiku")
    await clear_free_trial(s)
    assert s.connection_mode == "own_key"
    assert s.default_model == "sonnet"  # forced free-run pick handed back, not left on Haiku
    assert s.free_trial_token is None

    # A user who deliberately picked haiku OUTSIDE free-trial mode is left alone.
    s2 = AppSettings(connection_mode="own_key", default_model="haiku")
    await clear_free_trial(s2)
    assert s2.default_model == "haiku"


async def _noop(*_a, **_k):
    return None


def _record(bucket):
    async def _inner(obj, *_a, **_k):
        bucket.append(obj)
    return _inner
