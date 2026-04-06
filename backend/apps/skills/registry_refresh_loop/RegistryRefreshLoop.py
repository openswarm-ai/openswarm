import asyncio
import time
from typing import Optional

from typeguard import typechecked
from pydantic import BaseModel, Field, InstanceOf

from backend.apps.skills.registry_refresh_loop.fetch_all_registry_skills.fetch_all_registry_skills import fetch_all_registry_skills


class RegistryRefreshLoop(BaseModel):
    refresh_interval_s: int
    num_concurrent_fetches: int
    github_base_url: str
    github_repo: str
    github_branch: str
    manifest_extension: str
    cache: dict[str, dict] = Field(default_factory=dict)
    updated_at: float = 0
    task: Optional[InstanceOf[asyncio.Task]] = None

    @typechecked
    async def start(self) -> None:
        self._task = asyncio.create_task(self.p_run_loop())

    @typechecked
    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    @typechecked
    async def p_run_loop(self) -> None:
        while True:
            try:
                self.cache = await fetch_all_registry_skills(
                    num_concurrent_fetches=self.num_concurrent_fetches,
                    github_base_url=self.github_base_url,
                    github_repo=self.github_repo,
                    github_branch=self.github_branch,
                    manifest_extension=self.manifest_extension,
                )
                self.updated_at = time.time()
            except Exception as e:
                print(f"[RegistryRefreshLoop] Skill registry refresh error: {e}")
            await asyncio.sleep(self.refresh_interval_s)