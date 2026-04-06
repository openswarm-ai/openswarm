import asyncio
from typing import Optional
import httpx
from backend.apps.skills.parse_frontmatter import parse_frontmatter
from typeguard import typechecked

@typechecked
async def fetch_one_skill(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    folder: str,
    plugin_name: str,
    raw_base: str,
    repo: str,
    branch: str,
) -> Optional[dict]:
    async with sem:
        try:
            resp = await client.get(f"{raw_base}/{folder}/SKILL.md")
            if resp.status_code != 200:
                return None
            raw = resp.text
        except Exception as exc:
            print(f"[fetch_one_skill] Failed to fetch {folder}/SKILL.md: {exc}")
            return None

    meta, body = parse_frontmatter(raw)
    name = meta.get("name", "")
    if not name:
        name = folder.rsplit("/", 1)[-1].replace("-", " ").replace("_", " ").title()

    return {
        "name": name,
        "description": meta.get("description", ""),
        "content": body,
        "folder": folder,
        "category": plugin_name.replace("-", " ").replace("_", " ").title(),
        "repositoryUrl": f"https://github.com/{repo}/tree/{branch}/{folder}",
    }