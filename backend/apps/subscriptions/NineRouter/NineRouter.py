"""Singleton that owns 9Router process lifecycle and client access.

All interaction with 9Router from the subscriptions subapp goes through
NineRouter.get() so that mutable state (subprocess handle, background
ensure-task, HTTP client) lives in one place.
"""

import asyncio
from typing import ClassVar, Optional

from pydantic import BaseModel, Field, InstanceOf
from typeguard import typechecked

from backend.apps.subscriptions.NineRouter.helpers.NineRouterProcess.NineRouterProcess import NineRouterProcess
from backend.apps.subscriptions.NineRouter.helpers.NineRouterClient.NineRouterClient import NineRouterClient


class NineRouter(BaseModel):
    p_instance: ClassVar[Optional["NineRouter"]] = None
    p_process: NineRouterProcess = Field(default_factory=NineRouterProcess)
    p_client: NineRouterClient = Field(default_factory=NineRouterClient)
    p_ensure_task: Optional[InstanceOf[asyncio.Task]] = None

    @classmethod
    def get(cls) -> "NineRouter":
        if cls.p_instance is None:
            cls.p_instance = cls()
        return cls.p_instance

    # -- lifecycle -------------------------------------------------------------

    @typechecked
    def is_running(self) -> bool:
        return self.p_process.is_running()

    @typechecked
    async def ensure_running(self) -> None:
        await self.p_process.ensure_running()

    @typechecked
    async def stop(self) -> None:
        self.cancel_ensure_task()
        await self.p_client.aclose()
        self.p_process.stop()

    @typechecked
    async def ensure_running_background(self) -> None:
        """Kick off ensure_running as a background task if not already in flight."""
        if self.p_ensure_task is None or self.p_ensure_task.done():
            self.p_ensure_task = asyncio.create_task(self.p_process.ensure_running())

    @typechecked
    def cancel_ensure_task(self) -> None:
        if self.p_ensure_task and not self.p_ensure_task.done():
            self.p_ensure_task.cancel()

    # -- client ----------------------------------------------------------------

    @typechecked
    async def get_providers(self) -> list[dict] | dict:
        return await self.p_client.get_providers()

    @typechecked
    async def get_models(self) -> list[dict]:
        return await self.p_client.get_models()

    @typechecked
    async def start_oauth(self, provider: str) -> dict:
        return await self.p_client.start_oauth(provider)

    @typechecked
    async def poll_oauth(
        self,
        provider: str,
        device_code: str,
        code_verifier: str | None = None,
        extra_data: dict | None = None,
    ) -> dict:
        return await self.p_client.poll_oauth(provider, device_code, code_verifier=code_verifier, extra_data=extra_data)

    @typechecked
    async def exchange_oauth(
        self,
        provider: str,
        code: str,
        redirect_uri: str,
        code_verifier: str,
        state: str = "",
    ) -> dict:
        return await self.p_client.exchange_oauth(provider, code, redirect_uri, code_verifier, state)

    @typechecked
    async def disconnect_provider(self, provider_id: str) -> bool:
        return await self.p_client.disconnect_provider(provider_id)
