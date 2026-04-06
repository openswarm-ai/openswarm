"""Singleton that owns 9Router process lifecycle and client access.

All interaction with 9Router from the subscriptions subapp goes through
NineRouter.get() so that mutable state (subprocess handle, background
ensure-task, HTTP client) lives in one place.
"""

import asyncio
from typing import ClassVar, Optional

from typeguard import typechecked

from backend.apps.subscriptions.NineRouter.helpers.NineRouterProcess.NineRouterProcess import NineRouterProcess
from backend.apps.subscriptions.NineRouter.helpers.NineRouterClient.NineRouterClient import NineRouterClient


class NineRouter:
    _instance: ClassVar[Optional["NineRouter"]] = None

    def __init__(self) -> None:
        self._process: NineRouterProcess = NineRouterProcess()
        self._client: NineRouterClient = NineRouterClient()
        self._ensure_task: Optional[asyncio.Task] = None

    @classmethod
    def get(cls) -> "NineRouter":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # -- lifecycle -------------------------------------------------------------

    @typechecked
    def is_running(self) -> bool:
        return self._process.is_running()

    @typechecked
    async def ensure_running(self) -> None:
        await self._process.ensure_running()

    @typechecked
    async def stop(self) -> None:
        self.cancel_ensure_task()
        await self._client.aclose()
        self._process.stop()

    @typechecked
    async def ensure_running_background(self) -> None:
        """Kick off ensure_running as a background task if not already in flight."""
        if self._ensure_task is None or self._ensure_task.done():
            self._ensure_task = asyncio.create_task(self._process.ensure_running())

    @typechecked
    def cancel_ensure_task(self) -> None:
        if self._ensure_task and not self._ensure_task.done():
            self._ensure_task.cancel()

    # -- client ----------------------------------------------------------------

    @typechecked
    async def get_providers(self) -> list[dict] | dict:
        return await self._client.get_providers()

    @typechecked
    async def get_models(self) -> list[dict]:
        return await self._client.get_models()

    @typechecked
    async def start_oauth(self, provider: str) -> dict:
        return await self._client.start_oauth(provider)

    @typechecked
    async def poll_oauth(
        self,
        provider: str,
        device_code: str,
        code_verifier: str | None = None,
        extra_data: dict | None = None,
    ) -> dict:
        return await self._client.poll_oauth(provider, device_code, code_verifier=code_verifier, extra_data=extra_data)

    @typechecked
    async def exchange_oauth(
        self,
        provider: str,
        code: str,
        redirect_uri: str,
        code_verifier: str,
        state: str = "",
    ) -> dict:
        return await self._client.exchange_oauth(provider, code, redirect_uri, code_verifier, state)

    @typechecked
    async def disconnect_provider(self, provider_id: str) -> bool:
        return await self._client.disconnect_provider(provider_id)
