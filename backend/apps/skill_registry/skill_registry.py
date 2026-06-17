import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import Query
from backend.config.Apps import SubApp

logger = logging.getLogger(__name__)

REPO = "anthropics/skills"
BRANCH = "main"
RAW_BASE = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}"
MANIFEST_URL = f"{RAW_BASE}/.claude-plugin/marketplace.json"
REFRESH_INTERVAL_S = 3600
CONCURRENT_FETCHES = 15
# Retry the startup fetch on this short backoff (capped) until the FIRST success,
# instead of waiting a full REFRESH_INTERVAL_S after a cold/slow/failed fetch.
# That 1h gap was the "skills empty until reboot" bug on cold Windows networks.
_RETRY_BACKOFF_START_S = 2
_RETRY_BACKOFF_MAX_S = 60

# Catalog ships in the repo so a brand-new install shows skills with zero network
# (build snapshot), and every successful live fetch is persisted to the user's
# cache so subsequent launches are instant + offline-safe. The live fetch always
# overwrites both once it lands, so neither can go stale at runtime.
_BUNDLED_SNAPSHOT = os.path.join(os.path.dirname(__file__), "skills_snapshot.json")

_cache: dict[str, dict] = {}
_cache_updated_at: float = 0
_refresh_task: Optional[asyncio.Task] = None


def _disk_cache_path() -> str:
    base = os.environ.get("OPENSWARM_SKILL_CACHE_DIR") or os.path.expanduser(
        "~/.openswarm/cache"
    )
    return os.path.join(base, "skill_registry.json")


def _load_seed_cache() -> dict[str, dict]:
    """Return a non-empty catalog from the on-disk last-good cache, falling back
    to the bundled snapshot, so the registry is never empty on a cold/offline
    start. Returns {} only if neither source is present/valid."""
    for path in (_disk_cache_path(), _BUNDLED_SNAPSHOT):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and data:
                logger.info(f"Skill registry: seeded {len(data)} skills from {os.path.basename(path)}")
                return data
        except (OSError, ValueError):
            continue
    return {}


def _save_disk_cache(skills: dict[str, dict]) -> None:
    """Persist the last good live fetch so the next launch is instant. Atomic
    replace so a crash mid-write can't leave a truncated cache."""
    if not skills:
        return
    path = _disk_cache_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(skills, f)
        os.replace(tmp, path)
    except OSError:
        logger.debug("Skill registry: could not persist disk cache", exc_info=True)


def _parse_frontmatter(raw: str) -> tuple[dict, str]:
    """Split YAML frontmatter from markdown body."""
    if not raw.startswith("---"):
        return {}, raw
    end = raw.find("---", 3)
    if end == -1:
        return {}, raw
    fm_block = raw[3:end].strip()
    body = raw[end + 3:].strip()
    meta: dict = {}
    for line in fm_block.splitlines():
        m = re.match(r"^(\w[\w_-]*)\s*:\s*(.+)$", line)
        if m:
            meta[m.group(1).strip()] = m.group(2).strip().strip('"').strip("'")
    return meta, body


async def _fetch_skill_paths(client: httpx.AsyncClient) -> list[tuple[str, str]]:
    """Fetch the marketplace.json manifest and return (skill_folder, plugin_name) pairs.

    Uses raw.githubusercontent.com; no GitHub API needed, no rate limiting.
    """
    resp = await client.get(MANIFEST_URL)
    resp.raise_for_status()
    manifest = resp.json()

    paths: list[tuple[str, str]] = []
    for plugin in manifest.get("plugins", []):
        plugin_name = plugin.get("name", "")
        for skill_ref in plugin.get("skills", []):
            folder = skill_ref.lstrip("./")
            paths.append((folder, plugin_name))
    return paths


async def _fetch_one_skill(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    folder: str,
    plugin_name: str,
) -> Optional[dict]:
    async with sem:
        try:
            resp = await client.get(f"{RAW_BASE}/{folder}/SKILL.md")
            if resp.status_code != 200:
                return None
            raw = resp.text
        except Exception as exc:
            logger.debug(f"Failed to fetch {folder}/SKILL.md: {exc}")
            return None

    meta, body = _parse_frontmatter(raw)
    name = meta.get("name", "")
    if not name:
        folder_name = folder.rsplit("/", 1)[-1]
        name = folder_name.replace("-", " ").replace("_", " ").title()

    return {
        "name": name,
        "description": meta.get("description", ""),
        "content": body,
        "folder": folder,
        "category": plugin_name.replace("-", " ").replace("_", " ").title(),
        "repositoryUrl": f"https://github.com/{REPO}/tree/{BRANCH}/{folder}",
    }


async def _fetch_all_skills() -> dict[str, dict]:
    skills: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            paths = await _fetch_skill_paths(client)
        except Exception as e:
            logger.warning(f"Skill registry manifest fetch failed: {e}")
            return skills

        logger.info(f"Skill registry: found {len(paths)} skills in manifest, fetching content...")
        sem = asyncio.Semaphore(CONCURRENT_FETCHES)
        results = await asyncio.gather(
            *[_fetch_one_skill(client, sem, folder, plugin) for folder, plugin in paths]
        )
        for rec in results:
            if rec:
                skills[rec["name"]] = rec

    logger.info(f"Skill registry cache refreshed: {len(skills)} skills")
    return skills


async def _refresh_loop():
    global _cache, _cache_updated_at
    backoff = _RETRY_BACKOFF_START_S
    while True:
        ok = False
        try:
            fetched = await _fetch_all_skills()
            if fetched:
                _cache = fetched
                _cache_updated_at = time.time()
                _save_disk_cache(_cache)
                ok = True
        except Exception as e:
            logger.exception(f"Skill registry refresh error: {e}")
        if ok:
            # Settle to the slow hourly refresh once we have a good catalog.
            backoff = _RETRY_BACKOFF_START_S
            await asyncio.sleep(REFRESH_INTERVAL_S)
        else:
            # Cold/slow/failed fetch: retry soon (capped) until the first success
            # so a transient network hiccup doesn't leave the catalog empty for
            # an hour. The seeded snapshot keeps it non-empty meanwhile.
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _RETRY_BACKOFF_MAX_S)


@asynccontextmanager
async def skill_registry_lifespan():
    global _refresh_task, _cache
    # Seed instantly from disk/bundled snapshot so the very first request never
    # sees an empty catalog (the live fetch below overwrites it when it lands).
    if not _cache:
        _cache = _load_seed_cache()
    _refresh_task = asyncio.create_task(_refresh_loop())
    yield
    if _refresh_task:
        _refresh_task.cancel()
        try:
            await _refresh_task
        except asyncio.CancelledError:
            pass


skill_registry = SubApp("skill-registry", skill_registry_lifespan)


@skill_registry.router.get("/stats")
async def registry_stats():
    categories: dict[str, int] = {}
    for s in _cache.values():
        cat = s.get("category", "General")
        categories[cat] = categories.get(cat, 0) + 1
    return {
        "total": len(_cache),
        "categories": categories,
        "lastUpdated": _cache_updated_at,
    }


@skill_registry.router.get("/search")
async def registry_search(
    q: str = Query("", description="Search query"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    sort: str = Query("name", description="Sort by: name"),
    category: str = Query("", description="Filter by category"),
):
    pool = list(_cache.values())
    if category:
        cat_lower = category.lower()
        pool = [s for s in pool if s.get("category", "").lower() == cat_lower]

    query_lower = q.lower().strip()
    if query_lower:
        filtered = []
        for sk in pool:
            searchable = f"{sk['name']} {sk['description']} {sk.get('category', '')}".lower()
            if query_lower in searchable:
                filtered.append(sk)
        pool = filtered

    pool.sort(key=lambda s: s["name"].lower())
    total = len(pool)
    page = pool[offset : offset + limit]

    summary = [
        {
            "name": s["name"],
            "description": s["description"],
            "folder": s["folder"],
            "category": s.get("category", "General"),
            "repositoryUrl": s.get("repositoryUrl", ""),
        }
        for s in page
    ]
    return {"skills": summary, "total": total, "offset": offset, "limit": limit}


@skill_registry.router.get("/detail/{skill_name:path}")
async def registry_detail(skill_name: str):
    sk = _cache.get(skill_name)
    if not sk:
        return {"error": "Skill not found"}, 404
    return {"skill": sk}
