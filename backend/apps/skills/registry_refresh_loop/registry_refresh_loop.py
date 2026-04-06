


import asyncio
from datetime import time

from typeguard import typechecked
from backend.apps.skills.registry_refresh_loop.fetch_all_registry_skills.fetch_all_registry_skills import fetch_all_registry_skills

@typechecked
async def registry_refresh_loop(
    # Args needed for the loop
    refresh_interval_s: int,
    registry_cache: dict[str, dict],
    registry_updated_at: float,
    # Args needed for fetch_all_registry_skills
    num_concurrent_fetches: int,
    manifest_url: str,
    raw_base: str,
    repo: str,
    branch: str,
) -> None:
    while True:
        try:
            registry_cache = await fetch_all_registry_skills(
                num_concurrent_fetches=num_concurrent_fetches,
                manifest_url=manifest_url,
                raw_base=raw_base,
                repo=repo,
                branch=branch,
            )
            registry_updated_at = time.time()
        except Exception as e:
            print(f"[registry_refresh_loop] Skill registry refresh error: {e}")
        await asyncio.sleep(refresh_interval_s)