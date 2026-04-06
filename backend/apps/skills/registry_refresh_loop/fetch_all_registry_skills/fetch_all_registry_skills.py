



import asyncio
import httpx
from typeguard import typechecked
from backend.apps.skills.registry_refresh_loop.fetch_all_registry_skills.utils.fetch_skill_paths import fetch_skill_paths
from backend.apps.skills.registry_refresh_loop.fetch_all_registry_skills.utils.fetch_one_skill import fetch_one_skill


@typechecked
async def fetch_all_registry_skills(
    num_concurrent_fetches: int,
    manifest_url: str,
    raw_base: str,
    repo: str,
    branch: str,
) -> dict[str, dict]:
    result: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            paths = await fetch_skill_paths(
                client=client, 
                manifest_url=manifest_url
            )
        except Exception as e:
            print(f"[fetch_all_registry_skills] Skill registry manifest fetch failed: {e}")
            return result
        print(f"[fetch_all_registry_skills] Skill registry: found {len(paths)} skills in manifest, fetching...")
        sem = asyncio.Semaphore(num_concurrent_fetches)
        records = await asyncio.gather(
            *[fetch_one_skill(
                client=client, 
                sem=sem, 
                folder=folder, 
                plugin_name=plugin,
                raw_base=raw_base,
                repo=repo,
                branch=branch
            ) for folder, plugin in paths]
        )
        for rec in records:
            if rec:
                result[rec["name"]] = rec
    print(f"[fetch_all_registry_skills] Skill registry cache refreshed: {len(result)} skills")
    return result
