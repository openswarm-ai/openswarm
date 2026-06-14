"""Server-owned settings fields must survive full-object PUTs from the renderer.

Reproduces the production bug where a Settings save built from a pre-activation
snapshot (the renderer PUTs the ENTIRE AppSettings object) silently wiped
openswarm_bearer_token + connection_mode, disconnecting paying subscribers
minutes after a successful Stripe activation. The fix: subscription/identity
fields are written only by their dedicated endpoints (activate, signin-activate,
signout, disconnect); PUT /api/settings preserves whatever is on disk for them.
"""

from __future__ import annotations

import pytest
from unittest.mock import patch, AsyncMock
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture
def client():
    import backend.auth as auth_mod
    if not auth_mod.TOKEN:
        import secrets
        auth_mod.TOKEN = secrets.token_urlsafe(32)
    return TestClient(app, headers={"Authorization": f"Bearer {auth_mod.TOKEN}"})


@pytest.fixture
def reset_settings():
    from backend.apps.settings.store import load_settings, save_settings

    original = load_settings().model_copy(deep=True)
    yield
    save_settings(original)


def activate_pro(client, token="repro-bearer-0123456789abcdef"):
    """Drive the real /api/subscription/activate with a mocked cloud /api/me."""
    fake_me = AsyncMock()
    fake_me.status_code = 200
    fake_me.json = lambda: {
        "email": "payer@example.com",
        "plan": "pro",
        "status": "active",
        "current_period_end": 4102444800000,
        "usage": {"utilization": 0},
    }
    with patch("httpx.AsyncClient") as MockClient:
        instance = MockClient.return_value.__aenter__.return_value
        instance.get = AsyncMock(return_value=fake_me)
        r = client.post("/api/subscription/activate", json={"token": token})
    assert r.status_code == 200, r.text
    return token


@pytest.mark.usefixtures("reset_settings")
def test_stale_settings_put_cannot_wipe_activation(client):
    """The exact production sequence: snapshot settings, activate Pro, PUT the
    stale snapshot back (renderer Save of a pre-activation draft). The bearer
    and pro mode must survive; the user's editable change must still apply."""
    snapshot = client.get("/api/settings").json()
    assert snapshot is not None

    token = activate_pro(client)

    from backend.apps.settings.settings import load_settings
    s = load_settings()
    assert s.openswarm_bearer_token == token
    assert s.connection_mode == "openswarm-pro"
    assert s.openswarm_subscription_plan == "pro"

    stale = dict(snapshot)
    stale["user_name"] = "Stale Draft Save"
    r = client.put("/api/settings", json=stale)
    assert r.status_code == 200

    s = load_settings()
    assert s.user_name == "Stale Draft Save"
    assert s.openswarm_bearer_token == token, "stale PUT wiped the bearer"
    assert s.connection_mode == "openswarm-pro", "stale PUT reverted connection_mode"
    assert s.openswarm_subscription_plan == "pro"
    assert s.openswarm_subscription_expires is not None

    body = r.json()["settings"]
    assert body["openswarm_bearer_token"] == token
    assert body["connection_mode"] == "openswarm-pro"


@pytest.mark.usefixtures("reset_settings")
def test_put_cannot_inject_server_owned_fields(client):
    """The inverse direction: a client PUT must not be able to SET subscription
    state either (it would imply entitlement the cloud never granted)."""
    snapshot = client.get("/api/settings").json()
    forged = dict(snapshot)
    forged["connection_mode"] = "openswarm-pro"
    forged["openswarm_bearer_token"] = "forged-bearer-fedcba9876543210"
    forged["openswarm_subscription_plan"] = "ultra"
    forged["user_id"] = "u-forged"

    r = client.put("/api/settings", json=forged)
    assert r.status_code == 200

    from backend.apps.settings.settings import load_settings
    s = load_settings()
    assert s.openswarm_bearer_token == snapshot.get("openswarm_bearer_token")
    assert s.connection_mode == snapshot.get("connection_mode")
    assert s.openswarm_subscription_plan == snapshot.get("openswarm_subscription_plan")
    assert s.user_id == snapshot.get("user_id")


@pytest.mark.usefixtures("reset_settings")
def test_dedicated_endpoints_still_mutate(client):
    """Freezing PUT must not freeze the real owners: disconnect still reverts
    routing, and a fresh activate still re-connects afterwards."""
    activate_pro(client)

    r = client.post("/api/subscription/disconnect")
    assert r.status_code == 200
    from backend.apps.settings.settings import load_settings
    s = load_settings()
    assert s.connection_mode == "own_key"
    assert s.openswarm_bearer_token is not None  # disconnect keeps sign-in

    activate_pro(client, token="second-bearer-aaaabbbbccccdddd")
    s = load_settings()
    assert s.connection_mode == "openswarm-pro"
    assert s.openswarm_bearer_token == "second-bearer-aaaabbbbccccdddd"
