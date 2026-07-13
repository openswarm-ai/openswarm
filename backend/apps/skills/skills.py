import os
import hashlib
import json
import logging
import re
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from fastapi import HTTPException
from backend.config.Apps import SubApp
from backend.apps.skills.models import Skill, SkillCreate, SkillLoadRequest, SkillUpdate, SkillWorkspaceSeedRequest

logger = logging.getLogger(__name__)

SKILLS_DIR = os.path.expanduser("~/.claude/skills")
INDEX_PATH = os.path.join(SKILLS_DIR, ".skills_index.json")

from backend.config.paths import SKILLS_WORKSPACE_DIR


def load_index() -> dict[str, dict]:
    """Read the skill index, never raising on a corrupt file. A truncated/garbled
    index (e.g. a crash mid-write before atomic writes existed) is moved aside so
    it's recoverable, and we start empty rather than bricking every skill op,
    skills still list from their files with frontmatter/filename-derived names."""
    if not os.path.exists(INDEX_PATH):
        return {}
    try:
        with open(INDEX_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
        logger.warning("skills index was not an object; ignoring")
    except (OSError, ValueError):
        logger.warning("skills index unreadable; preserving aside and starting empty", exc_info=True)
    try:
        os.replace(INDEX_PATH, INDEX_PATH + ".corrupt")
    except OSError:
        pass
    return {}


# Guards the index write so an atomic replace is never interleaved by another writer. Today every index write runs on the single backend event-loop thread (no await between a load and its save, so no lost-update race), but this stays correct if a save ever moves to a thread pool the way settings' did.
p_index_write_lock = threading.Lock()


def save_index(index: dict[str, dict]):
    """Atomic index write: tmp file + os.replace so a crash mid-write can't leave
    a truncated index. Mirrors the settings store's write discipline."""
    with p_index_write_lock:
        os.makedirs(SKILLS_DIR, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".skills_index.", suffix=".tmp", dir=SKILLS_DIR)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(index, f, indent=2)
            # Windows: Defender can briefly lock the destination; one retry covers it.
            for attempt in range(2):
                try:
                    os.replace(tmp, INDEX_PATH)
                    return
                except PermissionError:
                    if attempt == 1:
                        raise
                    time.sleep(0.05)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


# Built-in skills shipped with OpenSwarm itself. Each entry describes a skill file we copy into ~/.claude/skills/ on first boot and tag with `built_in: true` in the index. Users can edit the content (their changes flow through to the matching agent's prompt on the next turn), but they can't delete the file; the DELETE endpoint refuses with 409.
def p_built_in_skill_registry() -> list[dict]:
    # Imported lazily so this module stays cheap to import from everywhere (the skills outputs module pulls in pydantic+fastapi transitively and we don't want a cycle).
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


def p_content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def seed_built_in_skills() -> None:
    """Copy each built-in skill into SKILLS_DIR and keep an *unedited* copy in sync
    with the bundled source across upgrades. Idempotent; safe on every boot.

    `seeded_hash` in the index records the bytes we last wrote. A file still hashing
    to it was never edited, so a newer bundle replaces it; a file that diverges is a
    user edit and is left alone. Installs predating `seeded_hash` can't be told apart
    from an edit, so we only claim provenance when the bytes already match the bundle
    -- otherwise they stay untracked and frozen, since silently clobbering a real edit
    is the worse failure. Before this, seeding was create-if-absent, so every install
    was pinned forever to whatever shipped the day it first booted."""
    index = load_index()
    dirty = False
    for entry in p_built_in_skill_registry():
        skill_id = entry["id"]
        fpath = os.path.join(SKILLS_DIR, f"{skill_id}.md")
        try:
            with open(entry["source_path"], encoding="utf-8") as src:
                bundled = src.read()
        except OSError:
            logger.warning("built-in skill source missing: %s", entry["source_path"])
            continue
        current = None
        if os.path.exists(fpath):
            try:
                with open(fpath, encoding="utf-8") as f:
                    current = f.read()
            except OSError:
                logger.warning("built-in skill unreadable, leaving as-is: %s", fpath, exc_info=True)
                continue
        meta = dict(index.get(skill_id, {}))
        seeded_hash = meta.get("seeded_hash")
        if current is None or (seeded_hash and p_content_hash(current) == seeded_hash):
            # Absent, or byte-identical to what we last seeded: no user edit to lose.
            if current != bundled:
                try:
                    os.makedirs(SKILLS_DIR, exist_ok=True)
                    with open(fpath, "w", encoding="utf-8") as dst:
                        dst.write(bundled)
                except OSError:
                    logger.warning("built-in skill write failed: %s", fpath, exc_info=True)
                    continue
            meta["seeded_hash"] = p_content_hash(bundled)
        elif not seeded_hash and current == bundled:
            # Untracked but already in sync; safe to adopt so the NEXT upgrade can move it.
            meta["seeded_hash"] = p_content_hash(bundled)
        # Anything else is a user edit, or an untracked install indistinguishable from one: leave both the file and its (absent) provenance alone so we never overwrite it.
        # Refresh index metadata. Existing user-changed name/description in the index stays, but built_in always gets re-asserted in case the index was created before this mechanism existed.
        meta.setdefault("name", entry["name"])
        meta.setdefault("description", entry["description"])
        meta.setdefault("command", entry["command"])
        if not meta.get("built_in"):
            meta["built_in"] = True
        if index.get(skill_id) != meta:
            index[skill_id] = meta
            dirty = True
    if dirty:
        save_index(index)


def p_prune_orphan_index() -> None:
    """Drop index entries whose skill files are gone (deleted out-of-band, e.g. a
    manual rm of the folder), so ghosts don't pile up as dead metadata or escalate
    install slugs (pdf -> pdf-2 -> pdf-3) by squatting a name with nothing on disk."""
    index = load_index()
    alive = {k: v for k, v in index.items() if skill_md_path(k)[0] is not None}
    if len(alive) != len(index):
        save_index(alive)


@asynccontextmanager
async def skills_lifespan():
    os.makedirs(SKILLS_DIR, exist_ok=True)
    os.makedirs(SKILLS_WORKSPACE_DIR, exist_ok=True)
    try:
        seed_built_in_skills()
        p_prune_orphan_index()
    except Exception:
        # Don't block app startup on a skill-seed failure; the worst case is the user has to manually paste the skill in once.
        logger.exception("failed to seed built-in skills")
    yield


skills = SubApp("skills", skills_lifespan)


def skill_md_path(skill_id: str) -> tuple[str | None, str]:
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


def p_has_supporting_files(skill_dir: str) -> bool:
    """True if a skill folder ships anything beyond its SKILL.md (scripts, templates)."""
    try:
        return any(e != "SKILL.md" and not e.startswith(".") for e in os.listdir(skill_dir))
    except OSError:
        return False


def p_build_skill(skill_id: str, content: str, md_path: str, kind: str, index: dict) -> Skill:
    """Assemble a Skill from disk + index, falling back to SKILL.md frontmatter
    for a folder skill the index hasn't catalogued (e.g. hand-dropped)."""
    meta = dict(index.get(skill_id, {}))
    if kind == "folder" and ("name" not in meta or "description" not in meta):
        fm = p_parse_skill_frontmatter(content)
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
        has_supporting_files=(kind == "folder" and p_has_supporting_files(skill_dir)),
        source=meta.get("source", ""),
        folder=meta.get("folder", ""),
        version=meta.get("version", ""),
    )


def sync_skills() -> list[Skill]:
    """Sync skills from the filesystem, updating the index. Reads both layouts:
    legacy flat <id>.md files and multi-file <id>/SKILL.md folders."""
    index = load_index()
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
        md_path, kind = skill_md_path(skill_id)
        if not md_path:
            continue
        with open(md_path, encoding="utf-8") as f:
            content = f.read()
        seen.add(skill_id)
        result.append(p_build_skill(skill_id, content, md_path, kind, index))

    return result


def format_skill_for_prompt(name: str, content: str, folder: str | None) -> str:
    """The exact prompt block for one skill, shared by manual attach
    (resolve_attached_skills) and the on-demand Skill tool so both inject
    byte-identical text. `folder` is the supporting-files dir when the skill
    ships any, else None."""
    block = f"[Using skill: {name}]\n\n{content}"
    if folder:
        block += (
            f"\n\nThis skill bundles supporting files in {folder}. "
            "Read them with your normal file tools (Read / Glob / Bash) when "
            "the steps above call for one; don't guess their contents."
        )
    return block


def p_resolve_skill(skill_id: str, skills_list: list[Skill]) -> Skill | None:
    """Resolve the identifier the model handed the Skill tool: exact id first,
    then a case-insensitive match on id/command/name so a near-miss still loads."""
    for s in skills_list:
        if s.id == skill_id:
            return s
    low = skill_id.strip().lower()
    for s in skills_list:
        if low and low in (s.id.lower(), s.command.lower(), s.name.lower()):
            return s
    return None


@skills.router.get("/list")
async def list_skills():
    return {"skills": [s.model_dump() for s in sync_skills()]}


@skills.router.post("/load")
async def load_skill(body: SkillLoadRequest):
    """Back the Skill tool: resolve a skill id to its prompt-ready text. On a miss
    we return the installed ids (not a 404) so the model can self-correct its next call."""
    skills_list = sync_skills()
    target = p_resolve_skill(body.id, skills_list)
    if target is None:
        return {"ok": False, "error": "unknown_skill", "available": [s.id for s in skills_list]}
    folder = target.dir_path if (target.dir_path and target.has_supporting_files) else None
    return {"ok": True, "text": format_skill_for_prompt(target.name, target.content, folder)}


def p_parse_skill_frontmatter(raw: str) -> dict:
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

    frontmatter = p_parse_skill_frontmatter(skill_content) if skill_content else {}

    return {
        "skill_content": skill_content,
        "meta": meta,
        "frontmatter": frontmatter,
    }


@skills.router.get("/{skill_id}")
async def get_skill(skill_id: str):
    for s in sync_skills():
        if s.id == skill_id:
            return s.model_dump()
    raise HTTPException(status_code=404, detail="Skill not found")


def clear_skill_dir(skill_id: str) -> None:
    """Empty a skill's folder before an in-place update so files removed upstream
    don't linger as orphans. write_folder_skill recreates the dir right after."""
    import shutil
    d = os.path.join(SKILLS_DIR, p_safe_slug(skill_id))
    if os.path.isdir(d):
        shutil.rmtree(d, ignore_errors=True)


def p_safe_slug(raw: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", (raw or "").strip().lower()).strip("-")
    return slug or "skill"


def p_skill_exists(slug: str) -> bool:
    # Existence is decided by FILES on disk only: a lingering index entry whose folder was deleted out-of-band (a manual rm) is a ghost and must not block reusing its slug.
    return (
        os.path.isfile(os.path.join(SKILLS_DIR, f"{slug}.md"))
        or os.path.isdir(os.path.join(SKILLS_DIR, slug))
    )


def unique_skill_slug(base: str) -> str:
    """A free slug for `base`, suffixing -2, -3, ... on collision. Lets a
    registry install land beside a same-named skill instead of silently
    overwriting the user's existing one."""
    slug = p_safe_slug(base)
    if not p_skill_exists(slug):
        return slug
    i = 2
    while p_skill_exists(f"{slug}-{i}"):
        i += 1
    return f"{slug}-{i}"


def write_folder_skill(skill_id: str, files: dict[str, str], meta: dict) -> Skill:
    """Write a multi-file skill folder (relpath -> content) under SKILLS_DIR and
    index it. `files` must include a 'SKILL.md'. Shared by registry install and
    zip/.swarm import. Relpaths that try to escape the skill folder (../, abs
    paths) are dropped, an untrusted registry archive can't write outside its
    own dir."""
    slug = p_safe_slug(skill_id)
    base = os.path.join(SKILLS_DIR, slug)
    base_abs = os.path.abspath(base)
    # A folder write supersedes any legacy flat <slug>.md, so we never leave a phantom flat file shadowed by the folder (folder wins in skill_md_path).
    legacy_flat = os.path.join(SKILLS_DIR, f"{slug}.md")
    if os.path.isfile(legacy_flat):
        try:
            os.remove(legacy_flat)
        except OSError:
            pass
    os.makedirs(base, exist_ok=True)
    for rel, content in files.items():
        dest = os.path.abspath(os.path.join(base, rel))
        if os.path.commonpath([base_abs, dest]) != base_abs:
            logger.warning("skill import: dropped path-escape entry %r", rel)
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as f:
            f.write(content)

    index = load_index()
    entry = {
        "name": meta.get("name") or slug,
        "description": meta.get("description", ""),
        "command": meta.get("command", slug),
    }
    # Carry provenance (source/folder/version) when an installer supplies it, so updates can be detected later. User-created skills omit these and stay un-versioned.
    for k in ("source", "folder", "version"):
        if meta.get(k):
            entry[k] = meta[k]
    index[slug] = entry
    save_index(index)

    md_path, kind = skill_md_path(slug)
    if not md_path:
        raise HTTPException(status_code=400, detail="skill had no SKILL.md")
    with open(md_path, encoding="utf-8") as f:
        content = f.read()
    return p_build_skill(slug, content, md_path, kind, index)


@skills.router.post("/create")
async def create_skill(body: SkillCreate):
    # All user skills are folders now (<id>/SKILL.md); flat files stay readable but are no longer written, so a skill's on-disk shape no longer depends on how it was created vs imported.
    meta = {"name": body.name, "description": body.description}
    if body.command:
        meta["command"] = body.command
    skill = write_folder_skill(body.name, {"SKILL.md": body.content}, meta)
    return {"ok": True, "skill": skill.model_dump()}


@skills.router.put("/{skill_id}")
async def update_skill(skill_id: str, body: SkillUpdate):
    md_path, kind = skill_md_path(skill_id)
    if not md_path:
        raise HTTPException(status_code=404, detail="Skill not found")

    if body.content is not None:
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(body.content)

    index = load_index()
    meta = index.get(skill_id, {})
    if body.name is not None:
        meta["name"] = body.name
    if body.description is not None:
        meta["description"] = body.description
    if body.command is not None:
        meta["command"] = body.command
    index[skill_id] = meta
    save_index(index)

    with open(md_path, encoding="utf-8") as f:
        content = f.read()

    skill = p_build_skill(skill_id, content, md_path, kind, index)
    return {"ok": True, "skill": skill.model_dump()}


@skills.router.delete("/{skill_id}")
async def delete_skill(skill_id: str):
    index = load_index()
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
    save_index(index)
    return {"ok": True}
