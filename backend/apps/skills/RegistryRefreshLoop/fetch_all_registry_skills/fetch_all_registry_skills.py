



import asyncio
import httpx
from typeguard import typechecked
from backend.apps.skills.RegistryRefreshLoop.fetch_all_registry_skills.utils.fetch_skill_paths import fetch_skill_paths
from backend.apps.skills.RegistryRefreshLoop.fetch_all_registry_skills.utils.fetch_one_skill import fetch_one_skill


@typechecked
async def fetch_all_registry_skills(
    num_concurrent_fetches: int,
    github_base_url: str,
    github_repo: str,
    github_branch: str,
    manifest_extension: str,
) -> dict[str, dict]:
    result: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            paths = await fetch_skill_paths(
                client=client, 
                manifest_url=f"{github_base_url}/{github_repo}/{github_branch}{manifest_extension}"
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
                github_base_url=github_base_url,
                github_repo=github_repo,
                github_branch=github_branch,
            ) for folder, plugin in paths]
        )
        for rec in records:
            if rec:
                result[rec["name"]] = rec
    print(f"[fetch_all_registry_skills] Skill registry cache refreshed: {len(result)} skills")
    return result
