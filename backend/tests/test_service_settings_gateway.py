"""Contract tests for the service app's injected SettingsGateway port.

Proves the lazy-import batch 3 inversion through public surface only:
service/client.py and service/analytics/client.py consult the injected
gateway for app settings (no reach into backend.apps.settings from
function bodies), the default adapter delegates to the real settings
store, and an injected fake fully controls behavior while the settings
app is patched to reject any access.

Run:
    python -m pytest backend/tests/test_service_settings_gateway.py -v
"""

from __future__ import annotations

import ast
import time
from pathlib import Path
from unittest.mock import patch

import pytest

import backend.apps.service.analytics.client as analytics_client
import backend.apps.service.client as service_client
import backend.apps.settings.store as settings_store
from backend.apps.service.settings_gateway import (
    DEFAULT_SETTINGS_GATEWAY,
    DefaultSettingsGateway,
    SettingsGateway,
)
from backend.apps.settings.credentials import OPENSWARM_DEFAULT_PROXY_URL
from backend.apps.settings.models import AppSettings


class FakeGateway:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.saved: list[AppSettings] = []

    def load(self) -> AppSettings:
        return self.settings

    def save(self, settings: AppSettings) -> None:
        self.saved.append(settings)

    def default_proxy_url(self) -> str:
        return "https://gateway-default.example.com"


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


@pytest.fixture
def settings_app_off_limits():
    def deny(*args, **kwargs):
        raise AssertionError("settings store must not be touched when a gateway is injected")
    with patch.object(settings_store, "load_settings", deny), patch.object(settings_store, "save_settings", deny):
        yield


@pytest.fixture
def sink():
    captured: list[tuple[str, dict]] = []
    service_client.set_test_sink(lambda kind, body: captured.append((kind, body)))
    yield captured


def envelope_of(captured: list[tuple[str, dict]]) -> dict:
    assert captured, "sync must reach the sink"
    return captured[0][1]["client_state"]


async def drain_one_spooled_post(tmp_path, gateway: SettingsGateway) -> str:
    spool = str(tmp_path / "spool.db")
    with patch.object(service_client, "spool_path", lambda: spool):
        service_client.buffer.enqueue(spool, "s:/api/service/sync", {"probe": 1}, now=time.time())
        CapturingAsyncClient.urls = []
        with patch.object(service_client.httpx, "AsyncClient", CapturingAsyncClient):
            drained = await service_client.drain_spool(gateway=gateway)
    assert drained == 1
    assert len(CapturingAsyncClient.urls) == 1
    return CapturingAsyncClient.urls[0]


# --- port conformance ---------------------------------------------------------

def test_default_adapter_conforms_to_protocol():
    assert isinstance(DefaultSettingsGateway(), SettingsGateway)
    assert isinstance(DEFAULT_SETTINGS_GATEWAY, SettingsGateway)


def test_default_adapter_proxy_url_is_the_credentials_constant():
    assert DefaultSettingsGateway().default_proxy_url() == OPENSWARM_DEFAULT_PROXY_URL


def test_fake_gateway_conforms_to_protocol():
    assert isinstance(FakeGateway(AppSettings()), SettingsGateway)


# --- service/client.py consumes only the injected gateway ---------------------

def test_resolve_timezone_uses_injected_gateway(settings_app_off_limits):
    fake = FakeGateway(AppSettings(timezone="Asia/Tokyo"))
    assert service_client.resolve_timezone(fake) == "Asia/Tokyo"


def test_resolve_locale_uses_injected_gateway(settings_app_off_limits):
    fake = FakeGateway(AppSettings(locale="ja-JP"))
    assert service_client.resolve_locale(fake) == "ja-JP"


@pytest.mark.asyncio
async def test_posts_use_injected_gateway_proxy_url(settings_app_off_limits, tmp_path):
    fake = FakeGateway(AppSettings(openswarm_proxy_url="https://proxy.example.com/"))
    url = await drain_one_spooled_post(tmp_path, fake)
    assert url == "https://proxy.example.com/api/service/sync"


@pytest.mark.asyncio
async def test_posts_use_injected_gateway_default_url(settings_app_off_limits, tmp_path):
    url = await drain_one_spooled_post(tmp_path, FakeGateway(AppSettings()))
    assert url == "https://gateway-default.example.com/api/service/sync"


def test_sync_envelope_flows_through_injected_gateway(settings_app_off_limits, sink):
    fake = FakeGateway(AppSettings(installation_id="install-inject", user_id="uid-inject"))
    service_client.sync({"probe": True}, fake)
    envelope = envelope_of(sink)
    assert envelope["install_id"] == "install-inject"
    assert envelope["user_id"] == "uid-inject"


def test_sync_generates_and_persists_install_id_through_injected_gateway(settings_app_off_limits, sink):
    fake = FakeGateway(AppSettings())
    service_client.sync({}, fake)
    generated = envelope_of(sink)["install_id"]
    assert generated
    assert fake.saved and fake.saved[0].installation_id == generated


def test_opt_out_gate_reads_through_injected_gateway(settings_app_off_limits, sink):
    service_client.sync({}, FakeGateway(AppSettings(analytics_opt_in=False)))
    assert sink == []
    service_client.sync({}, FakeGateway(AppSettings(analytics_opt_in=True)))
    assert len(sink) == 1


# --- analytics/client.py consumes only the injected gateway -------------------

def test_analytics_mode_reads_through_injected_gateway(settings_app_off_limits):
    modes: list[str] = []

    class FakeSDK:
        def __init__(self, *, base_url, token, mode):
            self.token = token
            modes.append(mode)

        @staticmethod
        def register(*, base_url, install_id):
            return "token-fresh"

    fake = FakeGateway(AppSettings(installation_id="i-1", analytics_token="t", analytics_opt_in=False))
    with patch.object(analytics_client, "AnalyticsClient", FakeSDK):
        assert analytics_client.get_analytics_client(fake) is not None
    assert modes == ["minimal"]


def test_analytics_bootstrap_persists_token_through_injected_gateway(settings_app_off_limits):
    fake = FakeGateway(AppSettings(installation_id="install-inject"))

    class FakeSDK:
        def __init__(self, *, base_url, token, mode):
            self.token = token

        @staticmethod
        def register(*, base_url, install_id):
            assert install_id == "install-inject"
            return "token-inject"

    with patch.object(analytics_client, "AnalyticsClient", FakeSDK):
        client = analytics_client.get_analytics_client(fake)
    assert client is not None and client.token == "token-inject"
    assert fake.saved and fake.saved[0].analytics_token == "token-inject"


def test_persist_client_env_writes_through_injected_gateway(settings_app_off_limits):
    fake = FakeGateway(AppSettings(timezone="UTC"))
    analytics_client.persist_client_env(timezone="Europe/Paris", locale="fr-FR", gateway=fake)
    assert fake.saved
    assert fake.saved[0].timezone == "Europe/Paris"
    assert fake.saved[0].locale == "fr-FR"


# --- the lazy sibling imports must not come back ------------------------------

def function_local_settings_imports(module_path: Path) -> list[int]:
    tree = ast.parse(module_path.read_text(encoding="utf-8"))
    offenders: list[int] = []

    def walk(node: ast.AST, in_function: bool) -> None:
        for child in ast.iter_child_nodes(node):
            inner = in_function or isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            if in_function and isinstance(child, (ast.Import, ast.ImportFrom)):
                names = [alias.name for alias in child.names] if isinstance(child, ast.Import) else [child.module or ""]
                if any(name.startswith("backend.apps.settings") for name in names):
                    offenders.append(child.lineno)
            walk(child, inner)

    walk(tree, False)
    return offenders


def test_service_clients_have_no_function_local_settings_imports():
    repo = Path(__file__).resolve().parents[2]
    for rel in ("backend/apps/service/client.py", "backend/apps/service/analytics/client.py"):
        assert function_local_settings_imports(repo / rel) == [], f"{rel} regressed to lazy settings imports"
