"""SkillExportable: skills are leaves (no deps, no requirements). A skill is
either a single markdown file or a folder (SKILL.md + supporting files like
scripts/templates), so this powers both the .swarm round-trip AND the generic
"import a .md or a zip-of-SKILL.md" path. Folder skills ride the entity files()
channel so their supporting files survive export/import. Nothing here is secret,
but the body still rides the central scrub in case someone pasted a token in."""
from __future__ import annotations

import os
import shutil

from backend.apps.skills import skills as store
from backend.apps.swarm.exportable import DepRef, ExportContext, RemapTable
from backend.apps.swarm.models import EntityType, Requirement


class SkillExportable:
    type = EntityType.skill

    def __init__(self, local_id: str, name: str, payload: dict, files: dict[str, bytes] | None = None):
        self.local_id = local_id
        self.name = name
        self.payload = payload
        self.p_files = files or {}

    @classmethod
    def load(cls, local_id: str) -> "SkillExportable | None":
        md_path, kind = store.skill_md_path(local_id)
        if not md_path:
            return None
        with open(md_path, encoding="utf-8") as f:
            content = f.read()
        meta = store.load_index().get(local_id, {})
        name = meta.get("name") or local_id.replace("-", " ").replace("_", " ").title()
        payload = {
            "slug": local_id,
            "name": name,
            "description": meta.get("description", ""),
            "command": meta.get("command", local_id),
            "content": content,
            "builtin": bool(meta.get("built_in", False)),
        }
        files: dict[str, bytes] = {}
        if kind == "folder":
            files = p_read_supporting_files(os.path.join(store.SKILLS_DIR, local_id))
        return cls(local_id, name, payload, files)

    def serialize(self, ctx: ExportContext) -> dict:
        return dict(self.payload)

    def files(self) -> dict[str, bytes]:
        return dict(self.p_files)

    def dependencies(self) -> list[DepRef]:
        return []

    def requirements(self) -> list[Requirement]:
        return []

    @classmethod
    def conflict(cls, payload: dict) -> str | None:
        slug = payload.get("slug") or ""
        if slug and p_slug_taken(slug):
            return "already exists; will be added as a copy"
        return None

    @classmethod
    def import_(cls, payload: dict, files: dict[str, bytes], remap: RemapTable) -> str:
        base = (payload.get("slug") or payload.get("name") or "skill").lower().replace(" ", "-")
        slug = p_free_slug(base)
        meta = {
            "name": payload.get("name", slug),
            "description": payload.get("description", ""),
            "command": payload.get("command", slug),
        }
        # Every imported skill lands as a folder (SKILL.md + any supporting files), one path for one-file and multi-file skills alike. write_folder_skill is path-traversal-safe, so an untrusted bundle can't escape the skill dir.
        bundle = {"SKILL.md": payload.get("content", "")}
        for rel, data in files.items():
            bundle[rel] = data.decode("utf-8", errors="replace")
        skill = store.write_folder_skill(slug, bundle, meta)
        return skill.id

    @classmethod
    def rollback(cls, local_id: str) -> None:
        skill_dir = os.path.join(store.SKILLS_DIR, local_id)
        flat = os.path.join(store.SKILLS_DIR, f"{local_id}.md")
        if os.path.isdir(skill_dir):
            shutil.rmtree(skill_dir, ignore_errors=True)
        if os.path.isfile(flat):
            os.remove(flat)
        index = store.load_index()
        if local_id in index:
            index.pop(local_id, None)
            store.save_index(index)


def p_read_supporting_files(skill_dir: str) -> dict[str, bytes]:
    """Every file in a skill folder except SKILL.md, as {relpath: bytes}."""
    out: dict[str, bytes] = {}
    for root, p_dirs, names in os.walk(skill_dir):
        for n in names:
            full = os.path.join(root, n)
            # Forward slashes: these keys travel inside .swarm bundles, and the importer joins them
            # onto the destination on whatever OS opens the bundle.
            rel = os.path.relpath(full, skill_dir).replace(os.sep, "/")
            if rel == "SKILL.md" or n.startswith("."):
                continue
            try:
                with open(full, "rb") as f:
                    out[rel] = f.read()
            except OSError:
                continue
    return out


def p_slug_taken(slug: str) -> bool:
    return (
        slug in store.load_index()
        or os.path.isfile(os.path.join(store.SKILLS_DIR, f"{slug}.md"))
        or os.path.isdir(os.path.join(store.SKILLS_DIR, slug))
    )


def p_free_slug(base: str) -> str:
    base = base or "skill"
    if not p_slug_taken(base):
        return base
    cand = f"{base}-imported"
    if not p_slug_taken(cand):
        return cand
    i = 2
    while p_slug_taken(f"{base}-imported-{i}"):
        i += 1
    return f"{base}-imported-{i}"
