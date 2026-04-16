"""Parse and install a .swarm bundle.

Two phases:
  1. preview_swarm_bundle(bytes)  →  returns manifest + conflicts (no writes)
  2. install_swarm_bundle(bytes, env, conflicts)  →  writes everything

Transactional: if any step fails during install, roll back all components
created so far.
"""

import io
import json
import logging
import os
import zipfile
from datetime import datetime
from typing import Any
from uuid import uuid4

from backend.apps.portable.schemas import Manifest, FORMAT_VERSION
from backend.apps.portable.exporter import _compute_checksum

logger = logging.getLogger(__name__)


class BundleError(Exception):
    pass


def _read_archive(data: bytes) -> dict[str, bytes]:
    """Read the .swarm zip into a {path: bytes} dict."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data), "r")
    except zipfile.BadZipFile:
        raise BundleError("File is not a valid .swarm archive (bad zip)")
    files: dict[str, bytes] = {}
    for name in zf.namelist():
        if name.endswith("/"):
            continue
        files[name] = zf.read(name)
    return files


def _parse_manifest(files: dict[str, bytes]) -> Manifest:
    raw = files.get("manifest.json")
    if raw is None:
        raise BundleError("Archive is missing manifest.json")
    try:
        data = json.loads(raw.decode())
    except json.JSONDecodeError as e:
        raise BundleError(f"manifest.json is not valid JSON: {e}")

    if data.get("format") != "swarm":
        raise BundleError("Not a .swarm bundle (format field mismatch)")

    fv = str(data.get("format_version", ""))
    if fv.split(".")[0] != FORMAT_VERSION.split(".")[0]:
        raise BundleError(
            f"Unsupported format_version {fv} (this build expects {FORMAT_VERSION})"
        )

    try:
        return Manifest(**data)
    except Exception as e:
        raise BundleError(f"manifest.json failed validation: {e}")


def _verify_checksum(files: dict[str, bytes], manifest: Manifest) -> None:
    expected = manifest.bundle.checksum
    if not expected:
        return
    actual = _compute_checksum(files)
    if actual != expected:
        raise BundleError(f"Checksum mismatch (expected {expected}, got {actual})")


def _existing_names(kind: str) -> set[str]:
    """Return the set of names already installed for a given component kind."""
    from backend.config.paths import (
        DASHBOARDS_DIR, OUTPUTS_DIR, TOOLS_DIR, MODES_DIR,
    )
    names: set[str] = set()
    if kind == "dashboard":
        d = DASHBOARDS_DIR
    elif kind == "app":
        d = OUTPUTS_DIR
    elif kind == "tool":
        d = TOOLS_DIR
    elif kind == "mode":
        d = MODES_DIR
    elif kind == "skill":
        d = os.path.expanduser("~/.claude/skills")
    else:
        return names

    if not os.path.exists(d):
        return names

    if kind == "skill":
        for fname in os.listdir(d):
            if fname.endswith(".md"):
                names.add(fname[:-3])
    else:
        for fname in os.listdir(d):
            if not fname.endswith(".json"):
                continue
            try:
                with open(os.path.join(d, fname)) as f:
                    data = json.load(f)
                if "name" in data:
                    names.add(data["name"])
            except Exception:
                pass
    return names


def preview_swarm_bundle(data: bytes) -> dict[str, Any]:
    """Phase 1: open the archive, validate it, return a preview payload."""
    files = _read_archive(data)
    manifest = _parse_manifest(files)
    _verify_checksum(files, manifest)

    conflicts: list[dict] = []
    existing_apps = _existing_names("app")
    existing_tools = _existing_names("tool")
    existing_modes = _existing_names("mode")
    existing_skills = _existing_names("skill")

    for app in manifest.contents.apps:
        if app.get("name") in existing_apps:
            conflicts.append({"type": "app", "id": app["id"], "name": app["name"]})
    for tool in manifest.contents.tools:
        if tool.get("name") in existing_tools:
            conflicts.append({"type": "tool", "id": tool["id"], "name": tool["name"]})
    for mode in manifest.contents.modes:
        if mode.get("name") in existing_modes:
            conflicts.append({"type": "mode", "id": mode["id"], "name": mode["name"]})
    for skill in manifest.contents.skills:
        if skill["id"] in existing_skills:
            conflicts.append({"type": "skill", "id": skill["id"], "name": skill["name"]})

    return {
        "manifest": manifest.model_dump(),
        "conflicts": conflicts,
    }


# ----------------------------------------------------------------------------
# Install phase
# ----------------------------------------------------------------------------


class InstallRollback:
    """Tracks every component we've created so we can undo on failure."""

    def __init__(self) -> None:
        self.skills: list[str] = []  # slugs
        self.tools: list[str] = []   # ids
        self.modes: list[str] = []   # ids
        self.apps: list[str] = []    # ids
        self.dashboards: list[str] = []  # ids

    def undo(self) -> None:
        from backend.config.paths import (
            DASHBOARDS_DIR, OUTPUTS_DIR, TOOLS_DIR, MODES_DIR,
        )
        for sid in self.skills:
            fpath = os.path.expanduser(f"~/.claude/skills/{sid}.md")
            if os.path.exists(fpath):
                try: os.remove(fpath)
                except Exception: pass
        for tid in self.tools:
            fpath = os.path.join(TOOLS_DIR, f"{tid}.json")
            if os.path.exists(fpath):
                try: os.remove(fpath)
                except Exception: pass
        for mid in self.modes:
            fpath = os.path.join(MODES_DIR, f"{mid}.json")
            if os.path.exists(fpath):
                try: os.remove(fpath)
                except Exception: pass
        for oid in self.apps:
            fpath = os.path.join(OUTPUTS_DIR, f"{oid}.json")
            if os.path.exists(fpath):
                try: os.remove(fpath)
                except Exception: pass
        for did in self.dashboards:
            fpath = os.path.join(DASHBOARDS_DIR, f"{did}.json")
            if os.path.exists(fpath):
                try: os.remove(fpath)
                except Exception: pass


def _substitute_placeholders(obj: Any, env: dict[str, str], component_id: str) -> Any:
    """Recursively replace ${USER_PROVIDED} values with env values."""
    from backend.apps.portable.secrets import PLACEHOLDER
    if isinstance(obj, dict):
        return {k: _substitute_placeholders(v, env, component_id) if v != PLACEHOLDER else env.get(f"{component_id}:{k}", "") for k, v in obj.items()}
    if isinstance(obj, list):
        return [_substitute_placeholders(v, env, component_id) for v in obj]
    return obj


def _install_skill(skill_id: str, files: dict[str, bytes], resolution: str = "replace") -> str:
    """Install a skill, returning the final slug used."""
    meta_raw = files.get(f"skills/{skill_id}/skill.json")
    md_raw = files.get(f"skills/{skill_id}/SKILL.md")
    if meta_raw is None or md_raw is None:
        raise BundleError(f"Skill {skill_id} is missing files in archive")
    meta = json.loads(meta_raw.decode())
    content = md_raw.decode()

    skills_dir = os.path.expanduser("~/.claude/skills")
    os.makedirs(skills_dir, exist_ok=True)

    slug = skill_id
    if resolution == "rename":
        suffix = 2
        while os.path.exists(os.path.join(skills_dir, f"{slug}-{suffix}.md")):
            suffix += 1
        slug = f"{slug}-{suffix}"
    elif resolution == "skip":
        return slug

    with open(os.path.join(skills_dir, f"{slug}.md"), "w") as f:
        f.write(content)

    index_path = os.path.join(skills_dir, ".skills_index.json")
    index = {}
    if os.path.exists(index_path):
        try:
            with open(index_path) as f:
                index = json.load(f)
        except Exception:
            index = {}
    index[slug] = {
        "name": meta.get("name", slug),
        "description": meta.get("description", ""),
        "command": meta.get("command", slug),
    }
    with open(index_path, "w") as f:
        json.dump(index, f, indent=2)

    return slug


def _install_tool(
    tool_id: str, files: dict[str, bytes], env: dict[str, str], resolution: str,
) -> tuple[str, str]:
    """Install a tool. Returns (old_id, new_id)."""
    from backend.config.paths import TOOLS_DIR
    raw = files.get(f"tools/{tool_id}/tool.json")
    if raw is None:
        raise BundleError(f"Tool {tool_id} missing in archive")
    tool = json.loads(raw.decode())

    if resolution == "skip":
        return tool_id, tool_id

    new_id = uuid4().hex
    tool["id"] = new_id
    if resolution == "rename":
        tool["name"] = f"{tool.get('name', 'tool')} (imported)"

    # Substitute env placeholders
    tool = _substitute_placeholders(tool, env, tool_id)

    os.makedirs(TOOLS_DIR, exist_ok=True)
    with open(os.path.join(TOOLS_DIR, f"{new_id}.json"), "w") as f:
        json.dump(tool, f, indent=2)
    return tool_id, new_id


def _install_mode(mode_id: str, files: dict[str, bytes], resolution: str) -> tuple[str, str]:
    from backend.config.paths import MODES_DIR
    raw = files.get(f"modes/{mode_id}/mode.json")
    if raw is None:
        raise BundleError(f"Mode {mode_id} missing in archive")
    mode = json.loads(raw.decode())

    if resolution == "skip":
        return mode_id, mode_id

    new_id = uuid4().hex
    mode["id"] = new_id
    mode["is_builtin"] = False
    if resolution == "rename":
        mode["name"] = f"{mode.get('name', 'mode')} (imported)"

    os.makedirs(MODES_DIR, exist_ok=True)
    with open(os.path.join(MODES_DIR, f"{new_id}.json"), "w") as f:
        json.dump(mode, f, indent=2)
    return mode_id, new_id


def _install_app(app_id: str, files: dict[str, bytes], env: dict[str, str], resolution: str) -> tuple[str, str]:
    from backend.config.paths import OUTPUTS_DIR
    raw = files.get(f"apps/{app_id}/app.json")
    if raw is None:
        raise BundleError(f"App {app_id} missing in archive")
    app = json.loads(raw.decode())

    if resolution == "skip":
        return app_id, app_id

    new_id = uuid4().hex
    app["id"] = new_id
    if resolution == "rename":
        app["name"] = f"{app.get('name', 'app')} (imported)"
    app["created_at"] = datetime.now().isoformat()
    app["updated_at"] = datetime.now().isoformat()

    app = _substitute_placeholders(app, env, app_id)

    os.makedirs(OUTPUTS_DIR, exist_ok=True)
    with open(os.path.join(OUTPUTS_DIR, f"{new_id}.json"), "w") as f:
        json.dump(app, f, indent=2)
    return app_id, new_id


def _install_dashboard(files: dict[str, bytes], app_id_map: dict[str, str]) -> str:
    from backend.config.paths import DASHBOARDS_DIR
    raw = files.get("dashboard/dashboard.json")
    if raw is None:
        raise BundleError("Archive is missing dashboard/dashboard.json")
    dashboard = json.loads(raw.decode())

    new_id = uuid4().hex
    dashboard["id"] = new_id
    dashboard["name"] = f"{dashboard.get('name', 'Imported Dashboard')} (imported)"
    dashboard["created_at"] = datetime.now().isoformat()
    dashboard["updated_at"] = datetime.now().isoformat()
    dashboard["auto_named"] = False

    # Rewrite view_card output_id references
    layout = dashboard.get("layout") or {}
    view_cards = layout.get("view_cards") or {}
    new_view_cards: dict = {}
    for key, card in view_cards.items():
        if not isinstance(card, dict):
            continue
        old_oid = card.get("output_id")
        new_oid = app_id_map.get(old_oid, old_oid) if old_oid else old_oid
        new_card = dict(card)
        new_card["output_id"] = new_oid
        # The layout dict keyed this by old output_id; rekey too
        new_view_cards[new_oid or key] = new_card
    layout["view_cards"] = new_view_cards
    layout["cards"] = {}
    layout["browser_cards"] = {}
    dashboard["layout"] = layout

    os.makedirs(DASHBOARDS_DIR, exist_ok=True)
    with open(os.path.join(DASHBOARDS_DIR, f"{new_id}.json"), "w") as f:
        json.dump(dashboard, f, indent=2)
    return new_id


def install_swarm_bundle(
    data: bytes,
    env: dict[str, str] | None = None,
    conflicts: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Phase 2: install every component in the bundle.

    env: maps "{component_id}:{key}" -> value for required_env entries.
    conflicts: maps "{type}:{id}" -> "replace" | "rename" | "skip".
    """
    env = env or {}
    conflicts = conflicts or {}

    files = _read_archive(data)
    manifest = _parse_manifest(files)
    _verify_checksum(files, manifest)

    rollback = InstallRollback()

    try:
        # Skills
        for skill in manifest.contents.skills:
            sid = skill["id"]
            resolution = conflicts.get(f"skill:{sid}", "replace")
            slug = _install_skill(sid, files, resolution)
            if resolution != "skip":
                rollback.skills.append(slug)

        # Tools
        for tool in manifest.contents.tools:
            tid = tool["id"]
            resolution = conflicts.get(f"tool:{tid}", "replace")
            _, new_tid = _install_tool(tid, files, env, resolution)
            if resolution != "skip":
                rollback.tools.append(new_tid)

        # Modes
        for mode in manifest.contents.modes:
            mid = mode["id"]
            resolution = conflicts.get(f"mode:{mid}", "replace")
            _, new_mid = _install_mode(mid, files, resolution)
            if resolution != "skip":
                rollback.modes.append(new_mid)

        # Apps (outputs) — build id translation map for dashboard rewrite
        app_id_map: dict[str, str] = {}
        for app in manifest.contents.apps:
            aid = app["id"]
            resolution = conflicts.get(f"app:{aid}", "replace")
            old_id, new_id = _install_app(aid, files, env, resolution)
            app_id_map[old_id] = new_id
            if resolution != "skip":
                rollback.apps.append(new_id)

        # Dashboard
        new_dashboard_id = _install_dashboard(files, app_id_map)
        rollback.dashboards.append(new_dashboard_id)

        return {
            "ok": True,
            "dashboard_id": new_dashboard_id,
            "installed": {
                "skills": rollback.skills,
                "tools": rollback.tools,
                "modes": rollback.modes,
                "apps": rollback.apps,
            },
        }
    except Exception as e:
        logger.exception("install_swarm_bundle failed — rolling back")
        rollback.undo()
        raise BundleError(f"Install failed, rolled back: {e}") from e
