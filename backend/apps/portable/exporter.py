"""Build a .swarm bundle for a given dashboard.

Produces an in-memory zip archive with:
  - manifest.json
  - dashboard/dashboard.json
  - apps/<id>/app.json                (outputs referenced by view_cards)
  - skills/<id>/skill.json + SKILL.md (all user skills)
  - tools/<id>/tool.json              (all user tools, secrets stripped)
  - modes/<id>/mode.json              (custom modes only)

The dashboard itself has session cards and browser cards stripped — those
are ephemeral per-user state. view_cards (outputs) are preserved so the
installed dashboard re-references the newly-created outputs.
"""

import hashlib
import io
import json
import logging
import os
import zipfile
from datetime import datetime, timezone
from uuid import uuid4

from backend.apps.portable.schemas import (
    Manifest,
    BundleInfo,
    BundleAuthor,
    Contents,
    RequiredEnv,
    Warnings,
)
from backend.apps.portable.secrets import strip_tool_config

logger = logging.getLogger(__name__)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_dashboard(dashboard_id: str) -> dict:
    from backend.config.paths import DASHBOARDS_DIR
    path = os.path.join(DASHBOARDS_DIR, f"{dashboard_id}.json")
    if not os.path.exists(path):
        raise FileNotFoundError(f"Dashboard {dashboard_id} not found")
    with open(path) as f:
        return json.load(f)


def _load_output(output_id: str) -> dict | None:
    from backend.config.paths import OUTPUTS_DIR
    path = os.path.join(OUTPUTS_DIR, f"{output_id}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def _load_all_skills() -> list[dict]:
    """Read all user skills from ~/.claude/skills/ as dicts."""
    skills_dir = os.path.expanduser("~/.claude/skills")
    index_path = os.path.join(skills_dir, ".skills_index.json")
    index: dict[str, dict] = {}
    if os.path.exists(index_path):
        try:
            with open(index_path) as f:
                index = json.load(f)
        except Exception:
            pass

    result = []
    if not os.path.exists(skills_dir):
        return result
    for fname in os.listdir(skills_dir):
        if not fname.endswith(".md"):
            continue
        fpath = os.path.join(skills_dir, fname)
        with open(fpath) as f:
            content = f.read()
        skill_id = fname[:-3]
        meta = index.get(skill_id, {})
        result.append({
            "id": skill_id,
            "name": meta.get("name", skill_id.replace("-", " ").title()),
            "description": meta.get("description", ""),
            "command": meta.get("command", skill_id),
            "content": content,
        })
    return result


def _load_all_tools() -> list[dict]:
    from backend.config.paths import TOOLS_DIR
    result = []
    if not os.path.exists(TOOLS_DIR):
        return result
    for fname in os.listdir(TOOLS_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(TOOLS_DIR, fname)) as f:
                result.append(json.load(f))
    return result


def _load_all_modes(include_builtin: bool = False) -> list[dict]:
    from backend.config.paths import MODES_DIR
    result = []
    if not os.path.exists(MODES_DIR):
        return result
    for fname in os.listdir(MODES_DIR):
        if not fname.endswith(".json"):
            continue
        with open(os.path.join(MODES_DIR, fname)) as f:
            mode = json.load(f)
        if mode.get("is_builtin") and not include_builtin:
            continue
        result.append(mode)
    return result


def _strip_dashboard_for_export(dashboard: dict) -> dict:
    """Remove session-local fields from a dashboard before bundling."""
    out = dict(dashboard)
    layout = dict(out.get("layout") or {})
    # Sessions and browsers are ephemeral per-user runtime state
    layout["cards"] = {}
    layout["browser_cards"] = {}
    layout["expanded_session_ids"] = []
    out["layout"] = layout
    out.pop("thumbnail", None)
    return out


def _compute_checksum(files: dict[str, bytes]) -> str:
    """Hash all archive entries except manifest.json."""
    h = hashlib.sha256()
    for path in sorted(files.keys()):
        if path == "manifest.json":
            continue
        h.update(path.encode())
        h.update(b"\0")
        h.update(files[path])
        h.update(b"\0")
    return f"sha256:{h.hexdigest()}"


def build_swarm_bundle(
    dashboard_id: str,
    author_name: str | None = None,
    author_url: str | None = None,
) -> tuple[bytes, str]:
    """Build a .swarm bundle for *dashboard_id*.

    Returns (zip_bytes, suggested_filename).
    """
    dashboard = _load_dashboard(dashboard_id)
    dashboard_name = dashboard.get("name", "Untitled Dashboard")

    # Collect referenced outputs from view_cards
    view_cards = (dashboard.get("layout") or {}).get("view_cards") or {}
    referenced_output_ids = {
        v.get("output_id") for v in view_cards.values() if isinstance(v, dict)
    }
    referenced_output_ids.discard(None)

    outputs: list[dict] = []
    for oid in referenced_output_ids:
        o = _load_output(oid)
        if o:
            outputs.append(o)

    skills = _load_all_skills()
    tools_raw = _load_all_tools()
    modes = _load_all_modes(include_builtin=False)

    # Strip secrets from tools and collect required_env entries
    required_env: list[RequiredEnv] = []
    tools: list[dict] = []
    warnings = Warnings()
    for t in tools_raw:
        stripped, stripped_keys = strip_tool_config(t)
        tools.append(stripped)
        for key in stripped_keys:
            if key == "oauth_tokens":
                continue  # not a user-fillable env var
            required_env.append(RequiredEnv(
                key=key,
                component_type="tool",
                component_id=stripped.get("id", ""),
                component_name=stripped.get("name", ""),
                description=f"Secret value for tool '{stripped.get('name', '')}'",
            ))
        # Detect stdio transport → executes code
        mcp = stripped.get("mcp_config") or {}
        if isinstance(mcp, dict) and mcp.get("command"):
            warnings.executes_code = True
            warnings.executes_code_reasons.append(
                f"Tool '{stripped.get('name', '')}' uses stdio transport and spawns a local process"
            )

    # Apps with backend code (python files) → executes code
    for o in outputs:
        files = o.get("files") or {}
        if any(name.endswith(".py") for name in files.keys()):
            warnings.executes_code = True
            warnings.executes_code_reasons.append(
                f"App '{o.get('name', '')}' contains Python backend code"
            )

    # Assemble the archive in memory
    archive_files: dict[str, bytes] = {}

    # Dashboard
    dashboard_clean = _strip_dashboard_for_export(dashboard)
    archive_files["dashboard/dashboard.json"] = json.dumps(dashboard_clean, indent=2).encode()

    # Apps
    for o in outputs:
        oid = o["id"]
        archive_files[f"apps/{oid}/app.json"] = json.dumps(o, indent=2).encode()

    # Skills
    for s in skills:
        sid = s["id"]
        meta = {k: v for k, v in s.items() if k != "content"}
        archive_files[f"skills/{sid}/skill.json"] = json.dumps(meta, indent=2).encode()
        archive_files[f"skills/{sid}/SKILL.md"] = s["content"].encode()

    # Tools
    for t in tools:
        tid = t.get("id", uuid4().hex)
        archive_files[f"tools/{tid}/tool.json"] = json.dumps(t, indent=2).encode()

    # Modes
    for m in modes:
        mid = m["id"]
        archive_files[f"modes/{mid}/mode.json"] = json.dumps(m, indent=2).encode()

    # Manifest
    contents = Contents(
        dashboard={"id": dashboard["id"], "name": dashboard_name},
        skills=[{"id": s["id"], "name": s["name"]} for s in skills],
        tools=[{
            "id": t.get("id", ""),
            "name": t.get("name", ""),
            "transport": "stdio" if (t.get("mcp_config") or {}).get("command") else "http",
        } for t in tools],
        apps=[{
            "id": o["id"],
            "name": o.get("name", ""),
            "has_backend": any(k.endswith(".py") for k in (o.get("files") or {}).keys()),
        } for o in outputs],
        modes=[{"id": m["id"], "name": m.get("name", "")} for m in modes],
    )

    checksum = _compute_checksum(archive_files)

    manifest = Manifest(
        bundle=BundleInfo(
            id=uuid4().hex,
            name=dashboard_name,
            description=None,
            author=BundleAuthor(name=author_name, url=author_url) if (author_name or author_url) else None,
            created_at=_iso_now(),
            checksum=checksum,
        ),
        contents=contents,
        required_env=required_env,
        warnings=warnings,
    )
    archive_files["manifest.json"] = manifest.model_dump_json(indent=2).encode()

    # Zip it up
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(archive_files.keys()):
            zf.writestr(path, archive_files[path])

    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in dashboard_name)
    filename = f"{safe_name or 'dashboard'}.swarm"
    return buf.getvalue(), filename
