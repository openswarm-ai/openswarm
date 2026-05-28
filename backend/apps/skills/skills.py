import os
import json
import logging
import re
from contextlib import asynccontextmanager
from fastapi import HTTPException
from backend.config.Apps import SubApp
from backend.apps.skills.models import Skill, SkillCreate, SkillUpdate, SkillWorkspaceSeedRequest

logger = logging.getLogger(__name__)

SKILLS_DIR = os.path.expanduser("~/.claude/skills")
INDEX_PATH = os.path.join(SKILLS_DIR, ".skills_index.json")

from backend.config.paths import SKILLS_WORKSPACE_DIR


def _load_index() -> dict[str, dict]:
    if os.path.exists(INDEX_PATH):
        with open(INDEX_PATH) as f:
            return json.load(f)
    return {}


def _save_index(index: dict[str, dict]):
    with open(INDEX_PATH, "w") as f:
        json.dump(index, f, indent=2)


# Built-in skills shipped with OpenSwarm itself. Each entry describes a
# skill file we copy into ~/.claude/skills/ on first boot and tag with
# `built_in: true` in the index. Users can edit the content (their
# changes flow through to the matching agent's prompt on the next turn),
# but they can't delete the file; the DELETE endpoint refuses with 409.
def _built_in_skill_registry() -> list[dict]:
    # Imported lazily so this module stays cheap to import from
    # everywhere (the skills outputs module pulls in pydantic+fastapi
    # transitively and we don't want a cycle).
    from backend.apps.outputs.view_builder_templates import (
        APP_BUILDER_SKILL_SOURCE_PATH,
        SWARM_DEBUG_SKILL_SOURCE_PATH,
    )
    return [
        {
            "id": "app_builder_skill",
            "name": "App Builder",
            "description": (
                "Reference doc the App Builder agent reads on every turn. "
                "Edit this to change how every App Builder agent behaves; "
                "your edits take effect on the next turn, no restart. "
                "Built-in: can be edited but not deleted."
            ),
            "command": "app-builder-skill",
            "source_path": APP_BUILDER_SKILL_SOURCE_PATH,
        },
        {
            "id": "swarm_debug_skill",
            "name": "swarm-debug Logger",
            "description": (
                "How to use `swarm_debug.debug()` in an App backend; the "
                "colored frame-aware logger that lands in the App Builder's "
                "Terminal pane under [BACKEND]. Edit to teach your debugging "
                "conventions to the App Builder agent. Built-in: editable, "
                "not deletable."
            ),
            "command": "swarm-debug-skill",
            "source_path": SWARM_DEBUG_SKILL_SOURCE_PATH,
        },
    ]


def _seed_built_in_skills() -> None:
    """Copy each built-in skill into SKILLS_DIR if not already present, and
    ensure the index has the `built_in: true` flag so the UI and DELETE
    endpoint know to treat it specially. Idempotent; safe to call on
    every boot. Doesn't overwrite the file once it exists (so user edits
    are preserved across restarts and upgrades)."""
    index = _load_index()
    dirty = False
    for entry in _built_in_skill_registry():
        skill_id = entry["id"]
        fpath = os.path.join(SKILLS_DIR, f"{skill_id}.md")
        if not os.path.exists(fpath):
            try:
                with open(entry["source_path"], encoding="utf-8") as src:
                    content = src.read()
                with open(fpath, "w", encoding="utf-8") as dst:
                    dst.write(content)
            except FileNotFoundError:
                logger.warning("built-in skill source missing: %s", entry["source_path"])
                continue
        # Refresh index metadata. Existing user-changed name/description
        # in the index stays, but built_in always gets re-asserted in case
        # the index was created before this mechanism existed.
        meta = dict(index.get(skill_id, {}))
        meta.setdefault("name", entry["name"])
        meta.setdefault("description", entry["description"])
        meta.setdefault("command", entry["command"])
        if not meta.get("built_in"):
            meta["built_in"] = True
            dirty = True
        if index.get(skill_id) != meta:
            index[skill_id] = meta
            dirty = True
    if dirty:
        _save_index(index)


@asynccontextmanager
async def skills_lifespan():
    os.makedirs(SKILLS_DIR, exist_ok=True)
    os.makedirs(SKILLS_WORKSPACE_DIR, exist_ok=True)
    try:
        _seed_built_in_skills()
    except Exception:
        # Don't block app startup on a skill-seed failure; the worst
        # case is the user has to manually paste the skill in once.
        logger.exception("failed to seed built-in skills")
    yield


skills = SubApp("skills", skills_lifespan)


def _sync_skills() -> list[Skill]:
    """Sync skills from the filesystem, updating the index."""
    index = _load_index()
    result = []

    if os.path.exists(SKILLS_DIR):
        for fname in os.listdir(SKILLS_DIR):
            if fname.endswith(".md"):
                fpath = os.path.join(SKILLS_DIR, fname)
                with open(fpath) as f:
                    content = f.read()

                skill_id = fname.replace(".md", "")
                meta = index.get(skill_id, {})
                skill = Skill(
                    id=skill_id,
                    name=meta.get("name", fname.replace(".md", "").replace("-", " ").replace("_", " ").title()),
                    description=meta.get("description", ""),
                    content=content,
                    file_path=fpath,
                    command=meta.get("command", fname.replace(".md", "")),
                    built_in=bool(meta.get("built_in", False)),
                )
                result.append(skill)

    return result


@skills.router.get("/list")
async def list_skills():
    return {"skills": [s.model_dump() for s in _sync_skills()]}


def _parse_skill_frontmatter(raw: str) -> dict:
    """Extract YAML frontmatter fields from a SKILL.md file."""
    if not raw.startswith("---"):
        return {}
    end = raw.find("---", 3)
    if end == -1:
        return {}
    fm_block = raw[3:end].strip()
    meta: dict = {}
    for line in fm_block.splitlines():
        m = re.match(r"^(\w[\w_-]*)\s*:\s*(.+)$", line)
        if m:
            meta[m.group(1).strip()] = m.group(2).strip().strip('"').strip("'")
    return meta


@skills.router.post("/workspace/seed")
async def seed_skill_workspace(body: SkillWorkspaceSeedRequest):
    folder = os.path.join(SKILLS_WORKSPACE_DIR, body.workspace_id)
    os.makedirs(folder, exist_ok=True)

    if body.skill_content:
        with open(os.path.join(folder, "SKILL.md"), "w") as f:
            f.write(body.skill_content)
    if body.meta:
        with open(os.path.join(folder, "meta.json"), "w") as f:
            json.dump(body.meta, f, indent=2)

    return {"path": os.path.abspath(folder)}


@skills.router.get("/workspace/{workspace_id}")
async def read_skill_workspace(workspace_id: str):
    folder = os.path.join(SKILLS_WORKSPACE_DIR, workspace_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")

    skill_content = None
    skill_path = os.path.join(folder, "SKILL.md")
    if os.path.isfile(skill_path):
        with open(skill_path) as f:
            skill_content = f.read()

    meta = None
    meta_path = os.path.join(folder, "meta.json")
    if os.path.isfile(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
        except json.JSONDecodeError:
            pass

    frontmatter = _parse_skill_frontmatter(skill_content) if skill_content else {}

    return {
        "skill_content": skill_content,
        "meta": meta,
        "frontmatter": frontmatter,
    }


@skills.router.get("/{skill_id}")
async def get_skill(skill_id: str):
    for s in _sync_skills():
        if s.id == skill_id:
            return s.model_dump()
    raise HTTPException(status_code=404, detail="Skill not found")


@skills.router.post("/create")
async def create_skill(body: SkillCreate):
    slug = body.name.lower().replace(" ", "-")
    fpath = os.path.join(SKILLS_DIR, f"{slug}.md")

    with open(fpath, "w") as f:
        f.write(body.content)

    index = _load_index()
    index[slug] = {
        "name": body.name,
        "description": body.description,
        "command": body.command or slug,
    }
    _save_index(index)

    skill = Skill(
        id=slug,
        name=body.name,
        description=body.description,
        content=body.content,
        file_path=fpath,
        command=body.command or slug,
    )
    pass
    return {"ok": True, "skill": skill.model_dump()}


@skills.router.put("/{skill_id}")
async def update_skill(skill_id: str, body: SkillUpdate):
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
        id=skill_id,
        name=meta.get("name", skill_id),
        description=meta.get("description", ""),
        content=content,
        file_path=fpath,
        command=meta.get("command", skill_id),
    )
    return {"ok": True, "skill": skill.model_dump()}


@skills.router.delete("/{skill_id}")
async def delete_skill(skill_id: str):
    index = _load_index()
    if index.get(skill_id, {}).get("built_in"):
        raise HTTPException(
            status_code=409,
            detail=(
                f"'{skill_id}' is a built-in skill and can't be deleted "
                "(edit its content instead; your edits take effect on "
                "the next agent turn)."
            ),
        )
    fpath = os.path.join(SKILLS_DIR, f"{skill_id}.md")
    if os.path.exists(fpath):
        os.remove(fpath)
    index.pop(skill_id, None)
    _save_index(index)
    return {"ok": True}
