"""Injected settings boundary for the service app."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from backend.apps.settings import credentials, store
from backend.apps.settings.models import AppSettings


@runtime_checkable
class SettingsGateway(Protocol):
    """Operations the service forwarders need from the settings app."""

    def load(self) -> AppSettings: ...

    def save(self, settings: AppSettings) -> None: ...

    def default_proxy_url(self) -> str: ...


class DefaultSettingsGateway:
    """Production adapter; dynamic lookups preserve established test seams."""

    def load(self) -> AppSettings:
        return store.load_settings()

    def save(self, settings: AppSettings) -> None:
        store.save_settings(settings)

    def default_proxy_url(self) -> str:
        return credentials.OPENSWARM_DEFAULT_PROXY_URL


DEFAULT_SETTINGS_GATEWAY: SettingsGateway = DefaultSettingsGateway()
