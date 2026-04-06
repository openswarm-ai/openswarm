"""Skills SubApp — local skill CRUD, workspace management, and remote registry."""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Any, Optional

from fastapi import HTTPException, Query
from pydantic import BaseModel

from backend.config.Apps import SubApp
from backend.config.paths import DB_ROOT
from backend.apps.skills.SkillStore import SkillStore
from backend.apps.skills.parse_frontmatter import parse_frontmatter
from backend.apps.skills.registry_refresh_loop.registry_refresh_loop import registry_refresh_loop

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths & singleton store
# ---------------------------------------------------------------------------

SKILLS_DIR = os.path.expanduser("~/.claude/skills")
SKILLS_WORKSPACE_DIR = os.path.join(DB_ROOT, "skills_workspace")

SKILL_STORE = SkillStore(skills_dir=SKILLS_DIR)

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
    os.makedirs(SKILLS_WORKSPACE_DIR, exist_ok=True)
    _refresh_task = asyncio.create_task(registry_refresh_loop(
        refresh_interval_s=_REFRESH_INTERVAL_S,
        registry_cache=_registry_cache,
        registry_updated_at=_registry_updated_at,
        num_concurrent_fetches=_CONCURRENT_FETCHES,
        manifest_url=_MANIFEST_URL,
        raw_base=_RAW_BASE,
    ))
    yield
    if _refresh_task:
        _refresh_task.cancel()
        try:
            await _refresh_task
        except asyncio.CancelledError:
            pass


skills = SubApp("skills", skills_lifespan)


# ===========================================================================
# Local skill routes
# ===========================================================================


@skills.router.get("/list")
async def list_skills():
    return {"skills": [s.model_dump() for s in SKILL_STORE.list_all()]}


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

    frontmatter, _ = parse_frontmatter(skill_content) if skill_content else ({}, "")

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
    s = SKILL_STORE.get(skill_id)
    if not s:
        raise HTTPException(status_code=404, detail="Skill not found")
    return s.model_dump()


class _SkillCreateBody(BaseModel):
    name: str
    description: str = ""
    content: str
    command: str = ""


@skills.router.post("/create")
async def create_skill(body: _SkillCreateBody):
    skill = SKILL_STORE.create(body.name, body.description, body.content, body.command)
    return {"ok": True, "skill": skill.model_dump()}


class _SkillUpdateBody(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    content: Optional[str] = None
    command: Optional[str] = None


@skills.router.put("/{skill_id}")
async def update_skill(skill_id: str, body: _SkillUpdateBody):
    try:
        skill = SKILL_STORE.update(
            skill_id, name=body.name, description=body.description,
            content=body.content, command=body.command,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"ok": True, "skill": skill.model_dump()}


@skills.router.delete("/{skill_id}")
async def delete_skill(skill_id: str):
    SKILL_STORE.delete(skill_id)
    return {"ok": True}

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
