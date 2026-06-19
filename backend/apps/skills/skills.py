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


def _skill_md_path(skill_id: str) -> tuple[str | None, str]:
    """Resolve where a skill's markdown lives: (path, kind).

    A skill is either a folder (~/.claude/skills/<id>/SKILL.md, multi-file) or a
    legacy flat file (~/.claude/skills/<id>.md). Folder wins if both exist. The
    one place that knows the layout, so get/update/delete never re-guess it."""
    folder_md = os.path.join(SKILLS_DIR, skill_id, "SKILL.md")
    if os.path.isfile(folder_md):
        return folder_md, "folder"
    flat_md = os.path.join(SKILLS_DIR, f"{skill_id}.md")
    if os.path.isfile(flat_md):
        return flat_md, "flat"
    return None, "flat"


def _has_supporting_files(skill_dir: str) -> bool:
    """True if a skill folder ships anything beyond its SKILL.md (scripts, templates)."""
    try:
        return any(e != "SKILL.md" and not e.startswith(".") for e in os.listdir(skill_dir))
    except OSError:
        return False


def _build_skill(skill_id: str, content: str, md_path: str, kind: str, index: dict) -> Skill:
    """Assemble a Skill from disk + index, falling back to SKILL.md frontmatter
    for a folder skill the index hasn't catalogued (e.g. hand-dropped)."""
    meta = dict(index.get(skill_id, {}))
    if kind == "folder" and ("name" not in meta or "description" not in meta):
        fm = _parse_skill_frontmatter(content)
        meta.setdefault("name", fm.get("name", ""))
        meta.setdefault("description", fm.get("description", ""))
    pretty = skill_id.replace("-", " ").replace("_", " ").title()
    skill_dir = os.path.join(SKILLS_DIR, skill_id)
    return Skill(
        id=skill_id,
        name=meta.get("name") or pretty,
        description=meta.get("description", ""),
        content=content,
        file_path=md_path,
        command=meta.get("command", skill_id),
        built_in=bool(meta.get("built_in", False)),
        dir_path=skill_dir if kind == "folder" else "",
        has_supporting_files=(kind == "folder" and _has_supporting_files(skill_dir)),
    )


def _sync_skills() -> list[Skill]:
    """Sync skills from the filesystem, updating the index. Reads both layouts:
    legacy flat <id>.md files and multi-file <id>/SKILL.md folders."""
    index = _load_index()
    result = []
    seen: set[str] = set()

    if not os.path.exists(SKILLS_DIR):
        return result

    for entry in os.listdir(SKILLS_DIR):
        full = os.path.join(SKILLS_DIR, entry)
        if os.path.isdir(full):
            skill_id = entry
        elif entry.endswith(".md"):
            skill_id = entry[: -len(".md")]
        else:
            continue
        if skill_id in seen:
            continue
        md_path, kind = _skill_md_path(skill_id)
        if not md_path:
            continue
        with open(md_path, encoding="utf-8") as f:
            content = f.read()
        seen.add(skill_id)
        result.append(_build_skill(skill_id, content, md_path, kind, index))

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


def _safe_slug(raw: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", (raw or "").strip().lower()).strip("-")
    return slug or "skill"


def _skill_exists(slug: str) -> bool:
    return (
        slug in _load_index()
        or os.path.isfile(os.path.join(SKILLS_DIR, f"{slug}.md"))
        or os.path.isdir(os.path.join(SKILLS_DIR, slug))
    )


def unique_skill_slug(base: str) -> str:
    """A free slug for `base`, suffixing -2, -3, ... on collision. Lets a
    registry install land beside a same-named skill instead of silently
    overwriting the user's existing one."""
    slug = _safe_slug(base)
    if not _skill_exists(slug):
        return slug
    i = 2
    while _skill_exists(f"{slug}-{i}"):
        i += 1
    return f"{slug}-{i}"


def write_folder_skill(skill_id: str, files: dict[str, str], meta: dict) -> Skill:
    """Write a multi-file skill folder (relpath -> content) under SKILLS_DIR and
    index it. `files` must include a 'SKILL.md'. Shared by registry install and
    zip/.swarm import. Relpaths that try to escape the skill folder (../, abs
    paths) are dropped, an untrusted registry archive can't write outside its
    own dir."""
    slug = _safe_slug(skill_id)
    base = os.path.join(SKILLS_DIR, slug)
    base_abs = os.path.abspath(base)
    os.makedirs(base, exist_ok=True)
    for rel, content in files.items():
        dest = os.path.abspath(os.path.join(base, rel))
        if os.path.commonpath([base_abs, dest]) != base_abs:
            logger.warning("skill import: dropped path-escape entry %r", rel)
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(content)

    index = _load_index()
    index[slug] = {
        "name": meta.get("name") or slug,
        "description": meta.get("description", ""),
        "command": meta.get("command", slug),
    }
    _save_index(index)

    md_path, kind = _skill_md_path(slug)
    if not md_path:
        raise HTTPException(status_code=400, detail="skill had no SKILL.md")
    with open(md_path, encoding="utf-8") as f:
        content = f.read()
    return _build_skill(slug, content, md_path, kind, index)


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
    md_path, kind = _skill_md_path(skill_id)
    if not md_path:
        raise HTTPException(status_code=404, detail="Skill not found")

    if body.content is not None:
        with open(md_path, "w", encoding="utf-8") as f:
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

    with open(md_path, encoding="utf-8") as f:
        content = f.read()

    skill = _build_skill(skill_id, content, md_path, kind, index)
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
    # Remove whichever layout exists: the whole folder, or the flat file.
    import shutil
    skill_dir = os.path.join(SKILLS_DIR, skill_id)
    flat = os.path.join(SKILLS_DIR, f"{skill_id}.md")
    if os.path.isdir(skill_dir):
        shutil.rmtree(skill_dir, ignore_errors=True)
    if os.path.isfile(flat):
        os.remove(flat)
    index.pop(skill_id, None)
    _save_index(index)
    return {"ok": True}
