"""Characterization tests for the service app's settings-dependent behavior.

Pins the CURRENT observable behavior of every service/client.py and
service/analytics/client.py code path that reads or writes app settings,
before those reads move behind the injected SettingsGateway port
(lazy-import batch 3). Everything is exercised through public surface
(resolve_* helpers, sync() + test sink, drain_spool() + captured HTTP,
get_analytics_client()); the seams used — a temp SETTINGS_FILE and
attribute patches on backend.apps.settings.store — are the same ones the
existing service suites use and must keep working after the refactor.

Two dead branches documented while characterizing: service_diagnostics_mode
is not an AppSettings field (pydantic drops it on load), and the
"diagnostic always flows" branch is unreachable because the public
pipeline gates every submission as kind "state".

Run:
    python -m pytest backend/tests/test_service_settings_characterization.py -v
"""

from __future__ import annotations

import json
import time
from unittest.mock import patch

import pytest

import backend.apps.service.analytics.client as analytics_client
import backend.apps.service.client as service_client
import backend.apps.settings.store as settings_store
from backend.apps.settings.credentials import OPENSWARM_DEFAULT_PROXY_URL


@pytest.fixture
def settings_file(tmp_path):
    def write(payload: dict) -> str:
        sf = tmp_path / "settings.json"
        sf.write_text(json.dumps(payload))
        return str(sf)
    old = settings_store.SETTINGS_FILE
    settings_store.p_cached_settings = None
    settings_store.p_cached_sig = None
    yield write
    settings_store.SETTINGS_FILE = old
    settings_store.p_cached_settings = None
    settings_store.p_cached_sig = None


@pytest.fixture(autouse=True)
def fresh_module_state():
    service_client.install_id = None
    service_client.p_user_id = None
    service_client.test_sink = None
    analytics_client.P_CLIENT = None
    yield
    service_client.install_id = None
    service_client.p_user_id = None
    service_client.test_sink = None
    analytics_client.P_CLIENT = None


def use_settings(settings_file, payload: dict) -> None:
    settings_store.SETTINGS_FILE = settings_file(payload)


def broken_settings_store():
    def boom():
        raise RuntimeError("settings unavailable")
    return patch.object(settings_store, "load_settings", boom)


def fresh_envelope() -> dict | None:
    """Run one sync() with fresh identity caches; return its envelope, or None if gated."""
    service_client.install_id = None
    service_client.p_user_id = None
    captured: list[tuple[str, dict]] = []
    service_client.set_test_sink(lambda kind, body: captured.append((kind, body)))
    service_client.sync({})
    return captured[0][1]["client_state"] if captured else None


class CapturingAsyncClient:
    """Stands in for httpx.AsyncClient; records POST URLs and reports 200."""

    urls: list[str] = []

    def __init__(self, timeout=None):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        type(self).urls.append(url)

        class Response:
            status_code = 200
        return Response()


async def drain_one_spooled_post(tmp_path) -> str:
    """Enqueue one spool row, drain it through the real pipeline, return the POST URL."""
    spool = str(tmp_path / "spool.db")
    with patch.object(service_client, "spool_path", lambda: spool):
        service_client.buffer.enqueue(spool, "s:/api/service/sync", {"probe": 1}, now=time.time())
        CapturingAsyncClient.urls = []
        with patch.object(service_client.httpx, "AsyncClient", CapturingAsyncClient):
            drained = await service_client.drain_spool()
    assert drained == 1
    assert len(CapturingAsyncClient.urls) == 1
    return CapturingAsyncClient.urls[0]


# --- resolve_timezone / resolve_locale ---------------------------------------

def test_resolvers_prefer_settings_values(settings_file):
    use_settings(settings_file, {"timezone": "America/Chicago", "locale": "fr-FR"})
    assert service_client.resolve_timezone() == "America/Chicago"
    assert service_client.resolve_locale() == "fr-FR"


def test_resolvers_fall_back_when_settings_empty_or_broken(settings_file):
    use_settings(settings_file, {})
    assert service_client.resolve_timezone()
    with broken_settings_store():
        tz, loc = service_client.resolve_timezone(), service_client.resolve_locale()
    assert isinstance(tz, str) and tz
    assert isinstance(loc, str) and loc


# --- base-url selection, proven through the drain pipeline --------------------

@pytest.mark.asyncio
async def test_posts_go_to_settings_proxy_with_trailing_slash_stripped(settings_file, tmp_path):
    use_settings(settings_file, {"openswarm_proxy_url": "https://proxy.example.com/"})
    assert await drain_one_spooled_post(tmp_path) == "https://proxy.example.com/api/service/sync"


@pytest.mark.asyncio
async def test_posts_default_to_credentials_constant(settings_file, tmp_path):
    use_settings(settings_file, {})
    assert await drain_one_spooled_post(tmp_path) == f"{OPENSWARM_DEFAULT_PROXY_URL.rstrip('/')}/api/service/sync"


@pytest.mark.asyncio
async def test_posts_fall_back_to_default_base_on_settings_failure(tmp_path):
    with broken_settings_store():
        url = await drain_one_spooled_post(tmp_path)
    assert url == "https://api.openswarm.com/api/service/sync"


# --- identity envelope, proven through sync() --------------------------------

def test_envelope_install_id_persisted_generated_and_failure_paths(settings_file):
    use_settings(settings_file, {"installation_id": "install-123"})
    assert fresh_envelope()["install_id"] == "install-123"
    use_settings(settings_file, {})
    generated = fresh_envelope()["install_id"]
    assert generated
    on_disk = json.loads(open(settings_store.SETTINGS_FILE, encoding="utf-8").read())
    assert on_disk["installation_id"] == generated
    with broken_settings_store():
        assert fresh_envelope()["install_id"]


def test_install_id_is_cached_across_syncs(settings_file):
    use_settings(settings_file, {"installation_id": "install-123"})
    assert fresh_envelope()["install_id"] == "install-123"
    use_settings(settings_file, {"installation_id": "install-other"})
    captured: list[tuple[str, dict]] = []
    service_client.set_test_sink(lambda kind, body: captured.append((kind, body)))
    service_client.sync({})
    assert captured[0][1]["client_state"]["install_id"] == "install-123"


def test_envelope_user_id_preference_fallback_absence_and_failure(settings_file):
    use_settings(settings_file, {"user_id": "uid-1", "user_email": "a@b.c"})
    assert fresh_envelope()["user_id"] == "uid-1"
    use_settings(settings_file, {"user_email": "a@b.c"})
    assert fresh_envelope()["user_id"] == "a@b.c"
    use_settings(settings_file, {})
    assert "user_id" not in fresh_envelope()
    with broken_settings_store():
        assert "user_id" not in fresh_envelope()


# --- opt-out gating -----------------------------------------------------------

def test_diagnostics_mode_key_is_ignored_because_not_a_settings_field(settings_file):
    # service_diagnostics_mode is not an AppSettings field, so pydantic drops it on load and the mode branches stay dead; gating follows analytics_opt_in alone.
    use_settings(settings_file, {"service_diagnostics_mode": "minimal", "analytics_opt_in": True})
    assert fresh_envelope() is not None
    use_settings(settings_file, {"service_diagnostics_mode": "full", "analytics_opt_in": False})
    assert fresh_envelope() is None


# --- analytics mode / bootstrap -----------------------------------------------

def analytics_client_with_fake_sdk(modes: list[str]):
    class FakeSDK:
        def __init__(self, *, base_url, token, mode):
            self.token = token
            modes.append(mode)

        @staticmethod
        def register(*, base_url, install_id):
            return "token-fresh"
    return patch.object(analytics_client, "AnalyticsClient", FakeSDK)


def test_analytics_mode_follows_opt_in(settings_file):
    use_settings(settings_file, {"installation_id": "i", "analytics_token": "t", "analytics_opt_in": False})
    modes: list[str] = []
    with analytics_client_with_fake_sdk(modes):
        assert analytics_client.get_analytics_client() is not None
    analytics_client.P_CLIENT = None
    use_settings(settings_file, {"installation_id": "i", "analytics_token": "t", "analytics_opt_in": True})
    with analytics_client_with_fake_sdk(modes):
        assert analytics_client.get_analytics_client() is not None
    assert modes == ["minimal", "full"]


def test_analytics_client_none_without_install_id_or_on_failure(settings_file):
    use_settings(settings_file, {})
    assert analytics_client.get_analytics_client() is None
    with broken_settings_store():
        assert analytics_client.get_analytics_client() is None


def test_analytics_client_registers_and_persists_token(settings_file):
    use_settings(settings_file, {"installation_id": "install-123"})

    class FakeSDK:
        def __init__(self, *, base_url, token, mode):
            self.token = token

        @staticmethod
        def register(*, base_url, install_id):
            assert install_id == "install-123"
            return "token-xyz"

    with patch.object(analytics_client, "AnalyticsClient", FakeSDK):
        client = analytics_client.get_analytics_client()
    assert client is not None and client.token == "token-xyz"
    on_disk = json.loads(open(settings_store.SETTINGS_FILE, encoding="utf-8").read())
    assert on_disk["analytics_token"] == "token-xyz"


def test_analytics_client_reuses_persisted_token(settings_file):
    use_settings(settings_file, {"installation_id": "install-123", "analytics_token": "token-old"})

    class FakeSDK:
        def __init__(self, *, base_url, token, mode):
            self.token = token

        @staticmethod
        def register(**kwargs):
            raise AssertionError("register must not be called when a token exists")

    with patch.object(analytics_client, "AnalyticsClient", FakeSDK):
        client = analytics_client.get_analytics_client()
    assert client is not None and client.token == "token-old"


# --- persist_client_env -------------------------------------------------------

def test_persist_client_env_writes_changed_values(settings_file):
    use_settings(settings_file, {"timezone": "UTC"})
    analytics_client.persist_client_env(timezone="Europe/Paris", locale="fr-FR")
    on_disk = json.loads(open(settings_store.SETTINGS_FILE, encoding="utf-8").read())
    assert on_disk["timezone"] == "Europe/Paris"
    assert on_disk["locale"] == "fr-FR"


def test_persist_client_env_skips_unchanged_and_blank_values(settings_file):
    use_settings(settings_file, {"timezone": "UTC", "locale": "en-US"})
    with patch.object(settings_store, "save_settings") as save:
        analytics_client.persist_client_env(timezone="UTC", locale="en-US")
        analytics_client.persist_client_env(timezone="  ", locale=None)
    save.assert_not_called()
