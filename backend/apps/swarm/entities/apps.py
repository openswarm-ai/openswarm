"""AppExportable: an app is an Output record + its workspace file tree. We carry
the editable source (frontend/, backend/, run.sh, package.json, .env.example,
meta) but NOT node_modules/.venv/dist (skip dirs) and NOT the live `.env` (it
holds the source machine's absolute paths + pinned port). On import we mint a
fresh output id + workspace id, drop the builder session link, and regenerate a
local `.env` with a free port. The app stays inert until the user opens it."""
from __future__ import annotations

import os
import shutil
import socket
from uuid import uuid4

from backend.apps.outputs.models import Output
from backend.apps.outputs.workspace_io import WALK_SKIP_DIRS, save, load_output
from backend.config.paths import OUTPUTS_DIR, OUTPUTS_WORKSPACE_DIR

from ..exportable import DepRef, ExportContext, RemapTable
from ..models import EntityType, Requirement

_MAX_APP_FILE = 25 * 1024 * 1024  # matches ziputil per-entry cap


class AppExportable:
    type = EntityType.app

    def __init__(self, output: Output):
        self.output = output
        self.local_id = output.id
        self.name = output.name or "Untitled App"

    @classmethod
    def load(cls, local_id: str) -> "AppExportable | None":
        o = load_output(local_id)
        return cls(o) if o else None

    def serialize(self, ctx: ExportContext) -> dict:
        return {
            "name": self.output.name,
            "description": self.output.description,
            "icon": self.output.icon,
            "input_schema": self.output.input_schema,
            "files": self.output.files,  # flat-app inline source; webapp apps leave this empty
        }

    def files(self) -> dict[str, bytes]:
        out: dict[str, bytes] = {}
        wsid = self.output.workspace_id
        if not wsid:
            return out
        folder = os.path.join(OUTPUTS_WORKSPACE_DIR, wsid)
        if not os.path.isdir(folder):
            return out
        for root, dirs, fnames in os.walk(folder):
            dirs[:] = [d for d in dirs if d not in WALK_SKIP_DIRS]
            for fn in fnames:
                # .env is install-specific (absolute paths + port); .env.example travels instead.
                if fn == ".env":
                    continue
                full = os.path.join(root, fn)
                if os.path.islink(full):
                    continue
                try:
                    if os.path.getsize(full) > _MAX_APP_FILE:
                        continue
                    with open(full, "rb") as f:
                        data = f.read()
                except OSError:
                    continue
                rel = os.path.relpath(full, folder).replace(os.sep, "/")
                out[f"workspace/{rel}"] = data
        return out

    def dependencies(self) -> list[DepRef]:
        return []

    def requirements(self) -> list[Requirement]:
        return []

    @classmethod
    def import_(cls, payload: dict, files: dict[str, bytes], remap: RemapTable) -> str:
        new_wsid = uuid4().hex
        folder = os.path.join(OUTPUTS_WORKSPACE_DIR, new_wsid)
        wrote_workspace = False
        for rel, data in files.items():
            if not rel.startswith("workspace/"):
                continue
            dest = _safe_join(folder, rel[len("workspace/"):])
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data)
            wrote_workspace = True
        if wrote_workspace:
            _localize_env(folder)

        o = Output(
            name=payload.get("name") or "Imported App",
            description=payload.get("description", ""),
            icon=payload.get("icon", "view_quilt"),
            input_schema=payload.get("input_schema") or {"type": "object", "properties": {}, "required": []},
            files=payload.get("files") or {},
            workspace_id=new_wsid if wrote_workspace else None,
            session_id=None,
        )
        save(o)
        return o.id

    @classmethod
    def rollback(cls, local_id: str) -> None:
        o = load_output(local_id)
        if o and o.workspace_id:
            shutil.rmtree(os.path.join(OUTPUTS_WORKSPACE_DIR, o.workspace_id), ignore_errors=True)
        p = os.path.join(OUTPUTS_DIR, f"{local_id}.json")
        if os.path.exists(p):
            os.remove(p)


def _safe_join(folder: str, rel: str) -> str:
    dest = os.path.realpath(os.path.join(folder, rel))
    root = os.path.realpath(folder)
    if dest != root and not dest.startswith(root + os.sep):
        raise ValueError("app file path escapes the workspace")
    return dest


def _free_port() -> int:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _localize_env(folder: str) -> None:
    """Regenerate the workspace .env on the importer's machine: a fresh port plus
    this install's absolute template/debugger paths (the source's were dropped)."""
    env_path = os.path.join(folder, ".env")
    example = os.path.join(folder, ".env.example")
    if not os.path.exists(env_path):
        if os.path.exists(example):
            shutil.copyfile(example, env_path)
        else:
            return  # flat app: no run.sh, no env needed
    try:
        from backend.apps.outputs.view_builder_templates import (
            DEBUGGER_PATH,
            TEMPLATE_BACKEND_PATH,
            patch_env_port,
            warm_venv_dir,
        )
    except Exception:
        return
    patch_env_port(env_path, "FRONTEND_PORT", str(_free_port()))
    patch_env_port(env_path, "OPENSWARM_TEMPLATE_BACKEND_PATH", TEMPLATE_BACKEND_PATH)
    patch_env_port(env_path, "OPENSWARM_DEBUGGER_PATH", DEBUGGER_PATH)
    try:
        patch_env_port(env_path, "OPENSWARM_BACKEND_VENV_CACHE", warm_venv_dir())
    except Exception:
        pass
