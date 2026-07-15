import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import HTTPException, Query
from pydantic import BaseModel

from backend.config.Apps import SubApp
from backend.apps.skill_registry import skill_registry_sources as sources
from backend.apps.skill_registry import skill_registry_cache as cache
from backend.apps.skill_registry.skill_registry_github import folder_tree_sha, RegistryRateLimited

logger = logging.getLogger(__name__)

REFRESH_INTERVAL_S = 3600
# Retry the startup fetch on this short backoff (capped) until the FIRST success, instead of waiting a full REFRESH_INTERVAL_S after a cold/slow/failed fetch. That 1h gap was the "skills empty until reboot" bug on cold Windows networks.
P_RETRY_BACKOFF_START_S = 2
P_RETRY_BACKOFF_MAX_S = 60

p_cache: dict[str, dict] = {}
p_cache_updated_at: float = 0
p_refresh_task: Optional[asyncio.Task] = None


async def p_refresh_loop():
    global p_cache, p_cache_updated_at
    backoff = P_RETRY_BACKOFF_START_S
    while True:
        ok = False
        try:
            fetched = await sources.fetch_all_skills()
            if fetched:
                p_cache = fetched
                p_cache_updated_at = time.time()
                cache.save_disk_cache(p_cache)
                ok = True
        except Exception as e:
            logger.exception(f"Skill registry refresh error: {e}")
        if ok:
            # Warm the curated file-tree on the SLOW path only (never on the fast failure-retry below, which would burn the 60/hr quota in seconds).
            await sources.warm_curated_tree()
            # Settle to the slow hourly refresh once we have a good catalog.
            backoff = P_RETRY_BACKOFF_START_S
            await asyncio.sleep(REFRESH_INTERVAL_S)
        else:
            # Cold/slow/failed fetch: retry soon (capped) until the first success so a transient network hiccup doesn't leave the catalog empty for an hour. The seeded snapshot keeps it non-empty meanwhile.
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, P_RETRY_BACKOFF_MAX_S)


@asynccontextmanager
async def skill_registry_lifespan():
    global p_refresh_task, p_cache
    # Seed instantly from disk/bundled snapshot so the very first request never sees an empty catalog (the live fetch below overwrites it when it lands).
    if not p_cache:
        p_cache = cache.load_seed_cache()
    p_refresh_task = asyncio.create_task(p_refresh_loop())
    yield
    if p_refresh_task:
        p_refresh_task.cancel()
        try:
            await p_refresh_task
        except asyncio.CancelledError:
            pass


skill_registry = SubApp("skill-registry", skill_registry_lifespan)


@skill_registry.router.get("/stats")
async def registry_stats():
    categories: dict[str, int] = {}
    for s in p_cache.values():
        cat = s.get("category", "General")
        categories[cat] = categories.get(cat, 0) + 1
    return {
        "total": len(p_cache),
        "categories": categories,
        "lastUpdated": p_cache_updated_at,
    }


@skill_registry.router.get("/search")
async def registry_search(
    q: str = Query("", description="Search query"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    sort: str = Query("name", description="Sort by: name"),
    category: str = Query("", description="Filter by category"),
    source: str = Query("curated", description="curated (vetted) | community (skills.sh wild registry)"),
):
    # The wild registry is a remote 600k-entry index, searched live, not mirrored.
    if source == "community":
        try:
            return await sources.community_search(q, limit)
        except Exception as e:
            logger.warning(f"community skill search failed: {e}")
            return {"skills": [], "total": 0, "offset": 0, "limit": limit, "source": "community", "error": "skills.sh unreachable"}
    return sources.search_curated(p_cache, q, category, offset, limit)


@skill_registry.router.get("/detail/{skill_name:path}")
async def registry_detail(skill_name: str):
    sk = p_cache.get(skill_name)
    if not sk:
        return {"error": "Skill not found"}, 404
    return {"skill": sk}


class p_InstallRequest(BaseModel):
    source: str
    skill_id: str
    confirm: bool = False


@skill_registry.router.post("/install")
async def registry_install(req: p_InstallRequest):
    """Install a community (skills.sh) skill, in two honest steps.

    confirm=false (default): resolve + return a disclosure (the SKILL.md and the
    list of files, flagging scripts) WITHOUT writing anything, so the user sees
    exactly what they're about to install from an unvetted repo.
    confirm=true: write the skill folder to ~/.claude/skills/. Files only; no
    script is executed here. Curated skills install via the normal skills CRUD;
    this endpoint is the wild-registry path."""
    try:
        resolved = await sources.resolve_community_skill(req.source, req.skill_id)
    except RegistryRateLimited:
        raise HTTPException(status_code=429, detail="GitHub rate limit hit fetching this skill; try again in a few minutes.")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"could not fetch skill: {e}")

    disclosure = {
        "name": resolved["name"],
        "description": resolved["description"],
        "repo_url": resolved["repo_url"],
        "skill_md": resolved["files"].get("SKILL.md", ""),
        "files": sorted(resolved["files"].keys()),
        "scripts": resolved["scripts"],
        "has_scripts": bool(resolved["scripts"]),
        "secret_findings": resolved.get("secret_findings", []),
    }
    if not req.confirm:
        return {"installed": False, "disclosure": disclosure}

    from backend.apps.skills.skills import write_folder_skill, unique_skill_slug
    # Never clobber an existing local skill that happens to share this slug; a wild-registry name collision lands as a copy instead of overwriting.
    slug = unique_skill_slug(resolved["skill_id"])
    skill = write_folder_skill(
        slug,
        resolved["files"],
        {
            "name": resolved["name"], "description": resolved["description"],
            "source": resolved.get("source", ""), "folder": resolved.get("folder", ""), "version": resolved.get("version", ""),
        },
    )
    return {"installed": True, "skill": skill.model_dump(), "disclosure": disclosure}


class p_CuratedInstallRequest(BaseModel):
    folder: str


def p_cached_curated_fallback(folder: str) -> Optional[dict]:
    """Offline/rate-limited curated-install fallback: rebuild a single-SKILL.md install
    payload from the warmed catalog (it already holds the SKILL.md body) so a curated
    install still works when GitHub is unreachable, minus the folder's extra files.
    Empty version means it's skipped by update checks until re-installed online."""
    cached = next((s for s in p_cache.values() if s.get("folder") == folder), None)
    if cached is None:
        return None
    name, description, body = cached.get("name", ""), cached.get("description", ""), cached.get("content", "")
    return {
        "skill_id": folder.rsplit("/", 1)[-1], "name": name, "description": description,
        "files": {"SKILL.md": f"---\nname: {name}\ndescription: {description}\n---\n\n{body}"},
        "scripts": [], "source": sources.REPO, "folder": folder, "version": "",
    }


@skill_registry.router.post("/install-curated")
async def registry_install_curated(req: p_CuratedInstallRequest):
    """Install a curated (anthropics/skills) skill with its FULL folder, not just
    SKILL.md, so scripts/assets land too (the old path wrote only SKILL.md, which
    left multi-file skills like pdf/docx with dead script references). Curated is
    the vetted source, so this is one-click; files are still written inert, never
    executed. When GitHub is unreachable (offline / rate-limited) it falls back to the
    catalog's cached SKILL.md, so the install still works (single file, no folder
    extras), restoring the old offline behavior."""
    try:
        resolved = await sources.resolve_curated_skill(req.folder)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        resolved = p_cached_curated_fallback(req.folder)
        if resolved is None:
            if isinstance(e, RegistryRateLimited):
                raise HTTPException(status_code=429, detail="GitHub rate limit hit and no cached copy of this skill; try again in a few minutes.")
            raise HTTPException(status_code=502, detail=f"GitHub unreachable and no cached copy: {e}")
        logger.info(f"curated install: GitHub unreachable ({type(e).__name__}); installing '{req.folder}' from cached SKILL.md (single file, no folder extras)")

    from backend.apps.skills.skills import write_folder_skill, unique_skill_slug
    slug = unique_skill_slug(resolved["skill_id"])
    skill = write_folder_skill(
        slug,
        resolved["files"],
        {
            "name": resolved["name"], "description": resolved["description"],
            "source": resolved.get("source", ""), "folder": resolved.get("folder", ""), "version": resolved.get("version", ""),
        },
    )
    return {
        "installed": True,
        "skill": skill.model_dump(),
        "files": sorted(resolved["files"].keys()),
        "scripts": resolved["scripts"],
    }


@skill_registry.router.get("/updates")
async def registry_updates():
    """Which installed skills have a newer version upstream. Curated skills check
    against the warmed tree (zero API calls); community skills re-fetch their repo
    tree (best-effort, deduped per repo, cached). A skill with no recorded source
    (user-created, or installed before versioning) is skipped, not reported."""
    from backend.apps.skills.skills import sync_skills
    outdated: list[str] = []
    checked: list[str] = []
    unknown: list[str] = []
    community_trees: dict[str, object] = {}
    for s in sync_skills():
        if not s.source or not s.folder or not s.version:
            continue
        if s.source == sources.REPO:
            tree = sources.curated_tree
        else:
            if s.source not in community_trees:
                community_trees[s.source] = await sources.safe_repo_tree(s.source)
            tree = community_trees[s.source]
        if not tree:
            unknown.append(s.id)
            continue
        current = folder_tree_sha(tree, s.folder)
        checked.append(s.id)
        if current and current != s.version:
            outdated.append(s.id)
    return {"outdated": outdated, "checked": checked, "unknown": unknown}


class p_UpdateRequest(BaseModel):
    skill_id: str


@skill_registry.router.post("/update")
async def registry_update(req: p_UpdateRequest):
    """Re-fetch an installed skill from its recorded source and overwrite it in place,
    bumping its version. Re-runs the secret scan and returns any findings so the UI can
    flag a community update that newly ships secrets. A skill with no source (user-made)
    can't be updated."""
    from backend.apps.skills.skills import sync_skills, write_folder_skill, clear_skill_dir
    target = next((s for s in sync_skills() if s.id == req.skill_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="skill not found")
    if not target.source or not target.folder:
        raise HTTPException(status_code=400, detail="this skill has no upstream source to update from")
    try:
        if target.source == sources.REPO:
            resolved = await sources.resolve_curated_skill(target.folder)
        else:
            resolved = await sources.resolve_community_skill(target.source, target.folder.rsplit("/", 1)[-1])
    except RegistryRateLimited:
        raise HTTPException(status_code=429, detail="GitHub rate limit hit; try again in a few minutes.")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"could not fetch skill: {e}")

    # Overwrite in place: clear first so files removed upstream don't linger, keep the user's command alias, refresh everything else from source.
    clear_skill_dir(target.id)
    skill = write_folder_skill(
        target.id,
        resolved["files"],
        {
            "name": resolved["name"], "description": resolved["description"], "command": target.command,
            "source": resolved.get("source", ""), "folder": resolved.get("folder", ""), "version": resolved.get("version", ""),
        },
    )
    return {
        "updated": True,
        "skill": skill.model_dump(),
        "scripts": resolved["scripts"],
        "secret_findings": resolved.get("secret_findings", []),
    }
