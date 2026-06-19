import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
from fastapi import HTTPException, Query
from pydantic import BaseModel
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
    source: str = Query("curated", description="curated (vetted) | community (skills.sh wild registry)"),
):
    # The wild registry is a remote 600k-entry index, searched live, not mirrored.
    if source == "community":
        try:
            return await _community_search(q, limit)
        except Exception as e:
            logger.warning(f"community skill search failed: {e}")
            return {"skills": [], "total": 0, "offset": 0, "limit": limit, "source": "community", "error": "skills.sh unreachable"}

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


# ---------------------------------------------------------------------------
# Community source: the skills.sh wild registry (~600k+ telemetry-ranked,
# zero-curation community skills, GitHub-repo backed). The curated source above
# (anthropics/skills) stays the default; community is opt-in via ?source=community
# and the UI flags it as unvetted. See .claude/SECURITY.md for the posture: this
# installs INERT files only (never executes), discloses scripts before commit,
# and any skill script later runs through the same gated Bash path as anything.
# ---------------------------------------------------------------------------

_COMMUNITY_SEARCH_URL = "https://skills.sh/api/search"
_GH_API = "https://api.github.com"
_GH_RAW = "https://raw.githubusercontent.com"
_MAX_SKILL_FILES = 60
_SCRIPT_EXTS = (".sh", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".php")


def _is_script_path(rel: str) -> bool:
    """Whether a skill file is executable code worth disclosing before install."""
    if rel.lower().endswith(_SCRIPT_EXTS):
        return True
    head = rel.split("/", 1)[0].lower()
    return head in ("scripts", "bin", "hooks")


def _select_skill_paths(tree: list[dict], skill_id: str) -> tuple[str, list[str]]:
    """From a GitHub recursive tree, pick the SKILL.md for `skill_id` (shortest
    matching path) and every file living beside it. Pure so the resolution logic
    is unit-tested without a network round-trip."""
    blobs = [t["path"] for t in tree if t.get("type") == "blob" and isinstance(t.get("path"), str)]
    candidates = [p for p in blobs if p.endswith(f"/{skill_id}/SKILL.md") or p == f"{skill_id}/SKILL.md"]
    if not candidates:
        raise ValueError(f"no SKILL.md for '{skill_id}' in this repo")
    skill_md = min(candidates, key=len)
    skill_dir = skill_md[: -len("/SKILL.md")] if "/" in skill_md else ""
    prefix = (skill_dir + "/") if skill_dir else ""
    members = [p for p in blobs if (p.startswith(prefix) if prefix else "/" not in p)]
    return skill_md, members[:_MAX_SKILL_FILES]


class RegistryRateLimited(Exception):
    """GitHub's unauthenticated API (60/hr) is exhausted; the caller surfaces a
    'try again shortly' rather than a generic failure."""


async def _fetch_repo_tree(client: httpx.AsyncClient, owner: str, repo: str) -> tuple[str, list[dict]]:
    """Recursive tree of owner/repo, trying main then master (one API call each,
    usually just one). Avoids a separate repo-meta call to halve GitHub API use.
    Raises RegistryRateLimited on a 403, ValueError if no usable branch."""
    last_status = None
    for branch in ("main", "master"):
        r = await client.get(f"{_GH_API}/repos/{owner}/{repo}/git/trees/{branch}?recursive=1")
        if r.status_code == 200:
            return branch, r.json().get("tree", [])
        if r.status_code == 403:
            raise RegistryRateLimited()
        last_status = r.status_code
    raise ValueError(f"repo {owner}/{repo} has no main/master branch (last status {last_status})")


async def resolve_community_skill(source: str, skill_id: str) -> dict:
    """Resolve a skills.sh entry (source='owner/repo', skill_id=folder name) to
    its files via the GitHub trees API. Returns name/description/repo_url plus
    {relpath: content} and the list of script files. Fetches text only; never
    runs anything. Raises ValueError on a bad source or a missing skill, and
    RegistryRateLimited when GitHub's anon API is exhausted."""
    owner, _, repo = source.partition("/")
    if not owner or not repo:
        raise ValueError(f"unrecognized source '{source}' (expected owner/repo)")
    headers = {"User-Agent": "openswarm-skill-registry", "Accept": "application/vnd.github+json"}
    async with httpx.AsyncClient(timeout=30.0, headers=headers) as client:
        branch, tree = await _fetch_repo_tree(client, owner, repo)
        skill_md, members = _select_skill_paths(tree, skill_id)
        skill_dir = skill_md[: -len("/SKILL.md")] if "/" in skill_md else ""
        prefix = (skill_dir + "/") if skill_dir else ""

        files: dict[str, str] = {}
        for p in members:
            rel = p[len(prefix):] if prefix else p
            raw = await client.get(f"{_GH_RAW}/{owner}/{repo}/{branch}/{p}")
            if raw.status_code == 200:
                files[rel] = raw.text
        if "SKILL.md" not in files:
            raise ValueError("SKILL.md could not be fetched")

    meta, _body = _parse_frontmatter(files["SKILL.md"])
    return {
        "name": meta.get("name") or skill_id,
        "description": meta.get("description", ""),
        "repo_url": f"https://github.com/{owner}/{repo}/tree/{branch}/{skill_dir}".rstrip("/"),
        "skill_id": skill_id,
        "files": files,
        "scripts": sorted(rel for rel in files if _is_script_path(rel)),
    }


async def _community_search(q: str, limit: int) -> dict:
    """Live-proxy a query to the skills.sh wild registry. Not cached: it's a
    600k-entry remote index, so we search it on demand rather than mirror it."""
    async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": "openswarm"}) as client:
        r = await client.get(_COMMUNITY_SEARCH_URL, params={"q": q or "skill"})
        r.raise_for_status()
        data = r.json()
    skills = []
    for s in (data.get("skills") or [])[:limit]:
        src = s.get("source", "")
        try:
            installs = int(s.get("installs") or 0)
        except (TypeError, ValueError):
            installs = 0
        skills.append({
            "name": s.get("name", ""),
            "description": f"{installs:,} installs",
            "folder": s.get("skillId", ""),
            "category": src,
            "repositoryUrl": f"https://github.com/{src}" if src else "",
            "source": src,
            "skillId": s.get("skillId", ""),
            "installs": installs,
            "community": True,
        })
    return {"skills": skills, "total": len(skills), "offset": 0, "limit": limit, "source": "community"}


class _InstallRequest(BaseModel):
    source: str
    skill_id: str
    confirm: bool = False


@skill_registry.router.post("/install")
async def registry_install(req: _InstallRequest):
    """Install a community (skills.sh) skill, in two honest steps.

    confirm=false (default): resolve + return a disclosure (the SKILL.md and the
    list of files, flagging scripts) WITHOUT writing anything, so the user sees
    exactly what they're about to install from an unvetted repo.
    confirm=true: write the skill folder to ~/.claude/skills/. Files only; no
    script is executed here. Curated skills install via the normal skills CRUD;
    this endpoint is the wild-registry path."""
    try:
        resolved = await resolve_community_skill(req.source, req.skill_id)
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
    }
    if not req.confirm:
        return {"installed": False, "disclosure": disclosure}

    from backend.apps.skills.skills import write_folder_skill, unique_skill_slug
    # Never clobber an existing local skill that happens to share this slug; a
    # wild-registry name collision lands as a copy instead of overwriting.
    slug = unique_skill_slug(resolved["skill_id"])
    skill = write_folder_skill(
        slug,
        resolved["files"],
        {"name": resolved["name"], "description": resolved["description"]},
    )
    return {"installed": True, "skill": skill.model_dump(), "disclosure": disclosure}
