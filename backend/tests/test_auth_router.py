"""Smoketests for the desktop-side auth subapp.

These tests don't hit the real cloud, they patch httpx so we can simulate
each cloud response and assert the local persistence + identify-status
logic is right across every gate-dismissal path the renderer cares about.
"""

from __future__ import annotations

import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture
def client():
    """Returns a TestClient pre-loaded with the local backend's auth token
    so the LocalAuthMiddleware doesn't reject our requests with 401."""
    import backend.auth as auth_mod
    if not auth_mod._TOKEN:
        # Tests sometimes run without backend.main's startup hook firing.
        # Generate a token directly so request_matches_token has something
        # to compare against.
        import secrets
        auth_mod._TOKEN = secrets.token_urlsafe(32)
    return TestClient(app, headers={"Authorization": f"Bearer {auth_mod._TOKEN}"})


@pytest.fixture
def reset_settings():
    """Snapshot + restore settings around each test so writes don't leak."""
    from backend.apps.settings.settings import load_settings, _save_settings

    original = load_settings().model_copy(deep=True)
    yield
    _save_settings(original)


# ---------------------------------------------------------------------------
# /api/auth/signin-activate
# ---------------------------------------------------------------------------

def test_signin_activate_persists_user_id(client, reset_settings):
    fake_response = AsyncMock()
    fake_response.status_code = 200
    fake_response.json = lambda: {
        "user_id": "u-1234",
        "email": "smoke@example.com",
        "plan": "free",
        "expires": None,
        "signin_method": "google",
    }
    with patch("httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.post = AsyncMock(return_value=fake_response)

        r = client.post(
            "/api/auth/signin-activate",
            json={
                "token": "fake-bearer-1234567890abcdef",
                "signin_method": "google",
                "email": "smoke@example.com",
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert body["user_id"] == "u-1234"
    assert body["email"] == "smoke@example.com"
    assert body["plan"] == "free"

    # Persisted to settings.
    from backend.apps.settings.settings import load_settings
    s = load_settings()
    assert s.user_id == "u-1234"
    assert s.user_email == "smoke@example.com"
    assert s.signin_method == "google"


def test_signin_activate_paid_user_flips_pro_mode(client, reset_settings):
    """A signed-in user who already has a Stripe subscription should also
    flip into openswarm-pro routing, covers the Google-then-Stripe and
    Stripe-then-Google merge cases."""
    fake_response = AsyncMock()
    fake_response.status_code = 200
    fake_response.json = lambda: {
        "user_id": "u-paid",
        "email": "paid@example.com",
        "plan": "pro",
        "expires": "2027-01-01T00:00:00.000Z",
        "signin_method": "google",
    }
    with patch("httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.post = AsyncMock(return_value=fake_response)

        r = client.post(
            "/api/auth/signin-activate",
            json={
                "token": "fake-paid-bearer-abcdef0123456789",
                "signin_method": "google",
            },
        )
    assert r.status_code == 200
    from backend.apps.settings.settings import load_settings
    s = load_settings()
    assert s.user_id == "u-paid"
    assert s.connection_mode == "openswarm-pro"
    assert s.openswarm_subscription_plan == "pro"
    assert s.openswarm_subscription_expires == "2027-01-01T00:00:00.000Z"


def test_signin_activate_invalid_token_returns_401(client, reset_settings):
    fake_response = AsyncMock()
    fake_response.status_code = 401
    fake_response.text = "Invalid token"
    with patch("httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.post = AsyncMock(return_value=fake_response)

        r = client.post(
            "/api/auth/signin-activate",
            json={"token": "definitely-bad-token-xxxx", "signin_method": "google"},
        )
    assert r.status_code == 401


def test_signin_activate_short_token_rejected_locally(client, reset_settings):
    """Short tokens rejected before we even hit the cloud, saves a round trip."""
    r = client.post(
        "/api/auth/signin-activate",
        json={"token": "short", "signin_method": "google"},
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# /api/auth/identity-status, gate-state for the renderer
# ---------------------------------------------------------------------------

def test_identity_status_signed_in_user_returns_authed_true(client, reset_settings):
    from backend.apps.settings.settings import load_settings, _save_settings
    s = load_settings()
    s.user_id = "u-already-signed-in"
    s.user_email = "in@example.com"
    s.signin_method = "google"
    _save_settings(s)

    r = client.get("/api/auth/identity-status")
    assert r.status_code == 200
    body = r.json()
    assert body["authed"] is True
    assert body["user_id"] == "u-already-signed-in"
    assert body["hard_gate"] is False


def test_identity_status_unsigned_no_install_id_hard_gates(client, reset_settings):
    from backend.apps.settings.settings import load_settings, _save_settings
    s = load_settings()
    s.user_id = None
    s.user_email = None
    s.signin_method = None
    s.installation_id = None
    _save_settings(s)

    r = client.get("/api/auth/identity-status")
    assert r.status_code == 200
    body = r.json()
    assert body["authed"] is False
    assert body["hard_gate"] is True


def test_identity_status_cloud_unreachable_fails_open_to_soft(client, reset_settings):
    """If the cloud is unreachable, fall back to soft gate so the user
    isn't locked out by a flaky network. Renderer retries on next mount."""
    from backend.apps.settings.settings import load_settings, _save_settings
    s = load_settings()
    s.user_id = None
    s.installation_id = "test-install-aaa"
    _save_settings(s)

    with patch("httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        # Simulate network error.
        import httpx as _httpx
        instance.get = AsyncMock(side_effect=_httpx.HTTPError("network down"))

        r = client.get("/api/auth/identity-status")
    assert r.status_code == 200
    body = r.json()
    assert body["authed"] is False
    assert body["hard_gate"] is False  # fail open


def test_identity_status_cloud_says_hard_gate(client, reset_settings):
    from backend.apps.settings.settings import load_settings, _save_settings
    s = load_settings()
    s.user_id = None
    s.installation_id = "test-install-bbb"
    _save_settings(s)

    fake_response = AsyncMock()
    fake_response.status_code = 200
    fake_response.json = lambda: {
        "authed": False,
        "hard_gate": True,
        "install_age_days": 60,
        "deadline_ts": 1000,
    }
    with patch("httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.get = AsyncMock(return_value=fake_response)

        r = client.get("/api/auth/identity-status")
    body = r.json()
    assert body["authed"] is False
    assert body["hard_gate"] is True
    assert body["install_age_days"] == 60


# ---------------------------------------------------------------------------
# /api/auth/signout
# ---------------------------------------------------------------------------

def test_signout_clears_local_identity(client, reset_settings):
    from backend.apps.settings.settings import load_settings, _save_settings
    s = load_settings()
    s.user_id = "u-bye"
    s.user_email = "bye@example.com"
    s.signin_method = "google"
    s.openswarm_bearer_token = "bearer-to-revoke-xxxxxxxx"
    s.connection_mode = "openswarm-pro"
    _save_settings(s)

    fake_response = AsyncMock()
    fake_response.status_code = 200
    with patch("httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.post = AsyncMock(return_value=fake_response)

        r = client.post("/api/auth/signout")
    assert r.status_code == 200

    s2 = load_settings()
    assert s2.user_id is None
    assert s2.user_email is None
    assert s2.signin_method is None
    assert s2.openswarm_bearer_token is None
    assert s2.connection_mode == "own_key"


def test_signout_succeeds_even_when_cloud_unreachable(client, reset_settings):
    """A flaky network shouldn't strand the user signed-in locally."""
    from backend.apps.settings.settings import load_settings, _save_settings
    s = load_settings()
    s.user_id = "u-flaky"
    s.openswarm_bearer_token = "bearer-flaky-network-xxxx"
    _save_settings(s)

    with patch("httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        import httpx as _httpx
        instance.post = AsyncMock(side_effect=_httpx.HTTPError("network down"))

        r = client.post("/api/auth/signout")
    assert r.status_code == 200
    s2 = load_settings()
    assert s2.user_id is None
    assert s2.openswarm_bearer_token is None
