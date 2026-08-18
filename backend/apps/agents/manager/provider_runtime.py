"""Injected runtime boundary for provider routing."""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from backend.apps import nine_router
from backend.apps.nine_router import process as nine_router_process
from backend.apps.settings import credentials
from backend.apps.settings.models import AppSettings


@runtime_checkable
class ProviderRuntime(Protocol):
    """Operations provider routing needs from sibling applications."""

    def router_is_running(self) -> bool: ...

    async def ensure_router_running(self) -> None: ...

    def has_persisted_connections(self) -> bool: ...

    def normalize_openai_compat_base_url(self, base_url: str) -> str: ...

    def proxy_auth(self, settings: AppSettings) -> tuple[str | None, str | None]: ...


class DefaultProviderRuntime:
    """Production adapter; dynamic lookups preserve established test seams."""

    def router_is_running(self) -> bool:
        return nine_router.is_running()

    async def ensure_router_running(self) -> None:
        await nine_router.ensure_running()

    def has_persisted_connections(self) -> bool:
        return nine_router_process.has_persisted_connections()

    def normalize_openai_compat_base_url(self, base_url: str) -> str:
        return nine_router.normalize_openai_compat_base_url(base_url)

    def proxy_auth(self, settings: AppSettings) -> tuple[str | None, str | None]:
        return credentials.proxy_auth(settings)


DEFAULT_PROVIDER_RUNTIME: ProviderRuntime = DefaultProviderRuntime()
