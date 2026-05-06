"""REST-surface tests for /api/agents/subscriptions.

These routes wrap 9Router (the bundled OAuth/proxy daemon). The
`backend.tests.conftest` already no-ops `nine_router.ensure_running` so
no node subprocess is spawned, but `nine_router.is_running()` still tries
a real `httpx.get` to localhost:20128 and we don't want any network
chatter from these tests. Two fixtures here:

  - `nine_router_down`  — pins is_running() to False.
  - `nine_router_up`    — pins is_running() to True and stubs the four
                          async helpers (get_providers, get_models,
                          start_oauth, poll_oauth, exchange_oauth) with
                          canned dicts.

Coverage:

  - GET  /subscriptions/status   — both down + up shapes.
  - POST /subscriptions/connect  — missing provider → 400; 503 when
                                   9Router is unavailable; happy path
                                   round-trips the device_code flow.
  - POST /subscriptions/poll     — missing provider / device_code → 400.
  - POST /subscriptions/exchange — missing provider / code → 400.
  - POST /subscriptions/disconnect — missing provider → 400.

Happy paths for poll / exchange / disconnect involve writing real
provider connection state via 9Router and are out of scope for the REST
surface tests; they're covered by the integration suite.
"""

from __future__ import annotations

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def nine_router_down(monkeypatch):
    """Pin nine_router.is_running() to False.

    Defends against the cached True branch in the real implementation
    (see _IS_RUNNING_TTL in backend/apps/nine_router.py) leaking from
    other test runs.
    """
    import backend.apps.nine_router as _nr

    monkeypatch.setattr(_nr, "is_running", lambda: False)
    # ensure_running is also stubbed in conftest, but re-stubbing here
    # makes the contract of this fixture self-evident.
    async def _async_noop(*args, **kwargs):
        return None

    monkeypatch.setattr(_nr, "ensure_running", _async_noop)
    return _nr


@pytest.fixture
def nine_router_up(monkeypatch):
    """Pretend 9Router is running and serve canned data.

    All async helpers used by the subscriptions routes are replaced.
    Tests can override individual helpers via `monkeypatch.setattr`
    after this fixture runs.
    """
    import backend.apps.nine_router as _nr

    monkeypatch.setattr(_nr, "is_running", lambda: True)

    async def _providers():
        return [
            {"provider": "claude", "id": "conn-1", "isActive": True},
        ]

    async def _models():
        return [{"id": "claude-sonnet-4", "owned_by": "anthropic"}]

    async def _start_oauth(provider: str):
        return {
            "flow": "device_code",
            "user_code": "ABCD-1234",
            "verification_uri": "https://example.com/activate",
            "device_code": "dev-code-xyz",
            "code_verifier": "",
            "extra_data": {},
        }

    async def _poll_oauth(provider, device_code, **_):
        return {"success": True, "connection": {"provider": provider, "id": "conn-1"}}

    async def _exchange_oauth(provider, code, redirect_uri, code_verifier, state=""):
        return {"success": True, "connection": {"provider": provider, "id": "conn-1"}}

    monkeypatch.setattr(_nr, "get_providers", _providers)
    monkeypatch.setattr(_nr, "get_models", _models)
    monkeypatch.setattr(_nr, "start_oauth", _start_oauth)
    monkeypatch.setattr(_nr, "poll_oauth", _poll_oauth)
    monkeypatch.setattr(_nr, "exchange_oauth", _exchange_oauth)
    return _nr


# ---------------------------------------------------------------------------
# GET /subscriptions/status
# ---------------------------------------------------------------------------


def test_status_when_9router_down(client, nine_router_down):
    resp = client.get("/api/agents/subscriptions/status")
    assert resp.status_code == 200
    assert resp.json() == {"running": False, "providers": [], "models": []}


def test_status_when_9router_up(client, nine_router_up):
    """When up, the route wraps providers in a `connections` envelope —
    the OnboardingModal and Settings UI both read `data.providers.connections`.
    Pin that shape so an accidental rename surfaces as a test failure."""
    resp = client.get("/api/agents/subscriptions/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["running"] is True
    assert "connections" in body["providers"]
    assert isinstance(body["providers"]["connections"], list)
    assert isinstance(body["models"], list)


# ---------------------------------------------------------------------------
# POST /subscriptions/connect
# ---------------------------------------------------------------------------


def test_connect_requires_provider(client, nine_router_down):
    resp = client.post("/api/agents/subscriptions/connect", json={})
    assert resp.status_code == 400


def test_connect_returns_503_when_9router_unavailable(client, nine_router_down):
    """Provider given but 9Router can't be started — the route returns
    503 with a Node-install hint. `nine_router_down` pins both
    is_running() AND ensure_running() so the route's retry path
    short-circuits."""
    resp = client.post(
        "/api/agents/subscriptions/connect",
        json={"provider": "claude"},
    )
    assert resp.status_code == 503


def test_connect_round_trips_device_code(client, nine_router_up):
    resp = client.post(
        "/api/agents/subscriptions/connect",
        json={"provider": "github"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["flow"] == "device_code"
    assert body["user_code"] == "ABCD-1234"
    assert body["device_code"] == "dev-code-xyz"


# ---------------------------------------------------------------------------
# POST /subscriptions/poll
# ---------------------------------------------------------------------------


def test_poll_requires_provider_and_device_code(client):
    """Both fields must be present. We test each missing-half separately
    so a regression that only validates one of them is caught."""
    no_provider = client.post(
        "/api/agents/subscriptions/poll",
        json={"device_code": "dev"},
    )
    assert no_provider.status_code == 400

    no_device = client.post(
        "/api/agents/subscriptions/poll",
        json={"provider": "claude"},
    )
    assert no_device.status_code == 400


# ---------------------------------------------------------------------------
# POST /subscriptions/exchange
# ---------------------------------------------------------------------------


def test_exchange_requires_provider_and_code(client):
    no_provider = client.post(
        "/api/agents/subscriptions/exchange",
        json={"code": "abc"},
    )
    assert no_provider.status_code == 400

    no_code = client.post(
        "/api/agents/subscriptions/exchange",
        json={"provider": "claude"},
    )
    assert no_code.status_code == 400


# ---------------------------------------------------------------------------
# POST /subscriptions/disconnect
# ---------------------------------------------------------------------------


def test_disconnect_requires_provider(client):
    resp = client.post("/api/agents/subscriptions/disconnect", json={})
    assert resp.status_code == 400
