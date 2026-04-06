"""Skills SubApp — local skill CRUD, workspace management, and remote registry."""

import asyncio
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Any, Optional

import httpx
from fastapi import HTTPException, Query
from pydantic import BaseModel

from backend.config.Apps import SubApp
from backend.config.paths import DB_ROOT
from backend.apps.skills.Skill import Skill

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

SKILLS_DIR = os.path.expanduser("~/.claude/skills")
INDEX_PATH = os.path.join(SKILLS_DIR, ".skills_index.json")
SKILLS_WORKSPACE_DIR = os.path.join(DB_ROOT, "skills_workspace")

# ---------------------------------------------------------------------------
# Registry constants
# ---------------------------------------------------------------------------

_REPO = "anthropics/skills"
_BRANCH = "main"
_RAW_BASE = f"https://raw.githubusercontent.com/{_REPO}/{_BRANCH}"
_MANIFEST_URL = f"{_RAW_BASE}/.claude-plugin/marketplace.json"
_REFRESH_INTERVAL_S = 3600
_CONCURRENT_FETCHES = 15

_registry_cache: dict[str, dict] = {}
_registry_updated_at: float = 0
_refresh_task: Optional[asyncio.Task] = None

# ---------------------------------------------------------------------------
# SubApp
# ---------------------------------------------------------------------------


@asynccontextmanager
async def skills_lifespan():
    global _refresh_task
    os.makedirs(SKILLS_DIR, exist_ok=True)
    os.makedirs(SKILLS_WORKSPACE_DIR, exist_ok=True)
    _refresh_task = asyncio.create_task(_registry_refresh_loop())
    yield
    if _refresh_task:
        _refresh_task.cancel()
        try:
            await _refresh_task
        except asyncio.CancelledError:
            pass


skills = SubApp("skills", skills_lifespan)


# ===========================================================================
# Local skill helpers
# ===========================================================================


def _load_index() -> dict[str, dict]:
    if os.path.exists(INDEX_PATH):
        with open(INDEX_PATH) as f:
            return json.load(f)
    return {}


def _save_index(index: dict[str, dict]) -> None:
    with open(INDEX_PATH, "w") as f:
        json.dump(index, f, indent=2)


def _slug(name: str) -> str:
    return name.lower().replace(" ", "-")


def _sync_skills() -> list[Skill]:
    """Scan ~/.claude/skills/ for .md files and reconcile with the sidecar index."""
    index = _load_index()
    result: list[Skill] = []
    if not os.path.exists(SKILLS_DIR):
        return result
    for fname in os.listdir(SKILLS_DIR):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(SKILLS_DIR, fname)
        with open(fpath) as f:
            content = f.read()
        skill_id = fname.removesuffix(".md")
        meta = index.get(skill_id, {})
        result.append(Skill(
            id=skill_id,
            name=meta.get("name", skill_id.replace("-", " ").replace("_", " ").title()),
            description=meta.get("description", ""),
            content=content,
            file_path=fpath,
            command=meta.get("command", skill_id),
        ))
    return result


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


# ===========================================================================
# Local skill routes
# ===========================================================================


@skills.router.get("/list")
async def list_skills():
    return {"skills": [s.model_dump() for s in _sync_skills()]}


@skills.router.get("/workspace/{workspace_id}")
async def read_skill_workspace(workspace_id: str):
    folder = os.path.join(SKILLS_WORKSPACE_DIR, workspace_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")

    skill_content: Optional[str] = None
    skill_path = os.path.join(folder, "SKILL.md")
    if os.path.isfile(skill_path):
        with open(skill_path) as f:
            skill_content = f.read()

    meta: Optional[dict] = None
    meta_path = os.path.join(folder, "meta.json")
    if os.path.isfile(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
        except json.JSONDecodeError:
            pass

    frontmatter, _ = _parse_frontmatter(skill_content) if skill_content else ({}, "")

    return {"skill_content": skill_content, "meta": meta, "frontmatter": frontmatter}


class _WorkspaceSeedBody(BaseModel):
    workspace_id: str
    skill_content: Optional[str] = None
    meta: Optional[dict[str, Any]] = None


@skills.router.post("/workspace/seed")
async def seed_skill_workspace(body: _WorkspaceSeedBody):
    folder = os.path.join(SKILLS_WORKSPACE_DIR, body.workspace_id)
    os.makedirs(folder, exist_ok=True)
    if body.skill_content:
        with open(os.path.join(folder, "SKILL.md"), "w") as f:
            f.write(body.skill_content)
    if body.meta:
        with open(os.path.join(folder, "meta.json"), "w") as f:
            json.dump(body.meta, f, indent=2)
    return {"path": os.path.abspath(folder)}


@skills.router.get("/detail/{skill_id}")
async def get_skill(skill_id: str):
    for s in _sync_skills():
        if s.id == skill_id:
            return s.model_dump()
    raise HTTPException(status_code=404, detail="Skill not found")


class _SkillCreateBody(BaseModel):
    name: str
    description: str = ""
    content: str
    command: str = ""


@skills.router.post("/create")
async def create_skill(body: _SkillCreateBody):
    slug = _slug(body.name)
    fpath = os.path.join(SKILLS_DIR, f"{slug}.md")
    with open(fpath, "w") as f:
        f.write(body.content)

    index = _load_index()
    index[slug] = {"name": body.name, "description": body.description, "command": body.command or slug}
    _save_index(index)

    skill = Skill(
        id=slug, name=body.name, description=body.description,
        content=body.content, file_path=fpath, command=body.command or slug,
    )
    return {"ok": True, "skill": skill.model_dump()}


class _SkillUpdateBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    content: Optional[str] = None
    command: Optional[str] = None


@skills.router.put("/{skill_id}")
async def update_skill(skill_id: str, body: _SkillUpdateBody):
    fpath = os.path.join(SKILLS_DIR, f"{skill_id}.md")
    if not os.path.exists(fpath):
        raise HTTPException(status_code=404, detail="Skill not found")

    if body.content is not None:
        with open(fpath, "w") as f:
            f.write(body.content)

    index = _load_index()
    meta = index.get(skill_id, {})
    if body.name is not None:
        meta["name"] = body.name
    if body.description is not None:
        meta["description"] = body.description
    if body.command is not None:
        meta["command"] = body.command
    index[skill_id] = meta
    _save_index(index)

    with open(fpath) as f:
        content = f.read()

    skill = Skill(
        id=skill_id, name=meta.get("name", skill_id),
        description=meta.get("description", ""),
        content=content, file_path=fpath, command=meta.get("command", skill_id),
    )
    return {"ok": True, "skill": skill.model_dump()}


@skills.router.delete("/{skill_id}")
async def delete_skill(skill_id: str):
    fpath = os.path.join(SKILLS_DIR, f"{skill_id}.md")
    if os.path.exists(fpath):
        os.remove(fpath)
    index = _load_index()
    index.pop(skill_id, None)
    _save_index(index)
    return {"ok": True}


# ===========================================================================
# Registry helpers
# ===========================================================================


async def _fetch_skill_paths(client: httpx.AsyncClient) -> list[tuple[str, str]]:
    """Fetch marketplace.json and return (folder, plugin_name) pairs."""
    resp = await client.get(_MANIFEST_URL)
    resp.raise_for_status()
    manifest = resp.json()
    paths: list[tuple[str, str]] = []
    for plugin in manifest.get("plugins", []):
        plugin_name = plugin.get("name", "")
        for skill_ref in plugin.get("skills", []):
            paths.append((skill_ref.lstrip("./"), plugin_name))
    return paths


async def _fetch_one_skill(
    client: httpx.AsyncClient,
    sem: asyncio.Semaphore,
    folder: str,
    plugin_name: str,
) -> Optional[dict]:
    async with sem:
        try:
            resp = await client.get(f"{_RAW_BASE}/{folder}/SKILL.md")
            if resp.status_code != 200:
                return None
            raw = resp.text
        except Exception as exc:
            logger.debug("Failed to fetch %s/SKILL.md: %s", folder, exc)
            return None

    meta, body = _parse_frontmatter(raw)
    name = meta.get("name", "")
    if not name:
        name = folder.rsplit("/", 1)[-1].replace("-", " ").replace("_", " ").title()

    return {
        "name": name,
        "description": meta.get("description", ""),
        "content": body,
        "folder": folder,
        "category": plugin_name.replace("-", " ").replace("_", " ").title(),
        "repositoryUrl": f"https://github.com/{_REPO}/tree/{_BRANCH}/{folder}",
    }


async def _fetch_all_registry_skills() -> dict[str, dict]:
    result: dict[str, dict] = {}
    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            paths = await _fetch_skill_paths(client)
        except Exception as e:
            logger.warning("Skill registry manifest fetch failed: %s", e)
            return result
        logger.info("Skill registry: found %d skills in manifest, fetching...", len(paths))
        sem = asyncio.Semaphore(_CONCURRENT_FETCHES)
        records = await asyncio.gather(
            *[_fetch_one_skill(client, sem, folder, plugin) for folder, plugin in paths]
        )
        for rec in records:
            if rec:
                result[rec["name"]] = rec
    logger.info("Skill registry cache refreshed: %d skills", len(result))
    return result


async def _registry_refresh_loop() -> None:
    global _registry_cache, _registry_updated_at
    while True:
        try:
            _registry_cache = await _fetch_all_registry_skills()
            _registry_updated_at = time.time()
        except Exception as e:
            logger.exception("Skill registry refresh error: %s", e)
        await asyncio.sleep(_REFRESH_INTERVAL_S)


# ===========================================================================
# Registry routes
# ===========================================================================


@skills.router.get("/registry/stats")
async def registry_stats():
    categories: dict[str, int] = {}
    for s in _registry_cache.values():
        cat = s.get("category", "General")
        categories[cat] = categories.get(cat, 0) + 1
    return {"total": len(_registry_cache), "categories": categories, "lastUpdated": _registry_updated_at}


@skills.router.get("/registry/search")
async def registry_search(
    q: str = Query("", description="Search query"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    sort: str = Query("name", description="Sort field"),
    category: str = Query("", description="Filter by category"),
):
    pool = list(_registry_cache.values())

    if category:
        cat_lower = category.lower()
        pool = [s for s in pool if s.get("category", "").lower() == cat_lower]

    query_lower = q.lower().strip()
    if query_lower:
        pool = [
            s for s in pool
            if query_lower in f"{s['name']} {s['description']} {s.get('category', '')}".lower()
        ]

    pool.sort(key=lambda s: s["name"].lower())
    total = len(pool)
    page = pool[offset: offset + limit]

    summaries = [
        {
            "name": s["name"],
            "description": s["description"],
            "folder": s["folder"],
            "category": s.get("category", "General"),
            "repositoryUrl": s.get("repositoryUrl", ""),
        }
        for s in page
    ]
    return {"skills": summaries, "total": total, "offset": offset, "limit": limit}


@skills.router.get("/registry/detail/{skill_name:path}")
async def registry_detail(skill_name: str):
    sk = _registry_cache.get(skill_name)
    if not sk:
        raise HTTPException(status_code=404, detail="Registry skill not found")
    return {"skill": sk}
