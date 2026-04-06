"""OpenSwarmApp Builder SubApp — CRUD, app management, file serving, and execution."""

import json
import mimetypes
import os
import shutil
from datetime import datetime
from contextlib import asynccontextmanager
from typing import Optional, Any
from pydantic import BaseModel

from fastapi import HTTPException
from fastapi.responses import Response

from backend.config.Apps import SubApp
from backend.core.db.PydanticStore import PydanticStore
from backend.apps.app_builder.OpenSwarmApp import OpenSwarmApp
from backend.config.paths import DB_ROOT
from backend.apps.app_builder.templates.templates import APP_BUILDER_SKILL, APP_BUILDER_TEMPLATE_FILES
from backend.apps.app_builder.utils.execute_backend_code import execute_backend_code, BackendExecResult
from backend.apps.app_builder.utils.walk_directory import walk_directory

APP_BUILDER_METADATA_DIR = os.path.join(DB_ROOT, "app_builder_metadata")
APP_BUILDER_CONTENT_DIR = os.path.join(APP_BUILDER_METADATA_DIR, "app_builder_content")

@asynccontextmanager
async def app_builder_lifespan():
    os.makedirs(APP_BUILDER_METADATA_DIR, exist_ok=True)
    os.makedirs(APP_BUILDER_CONTENT_DIR, exist_ok=True)
    yield


app_builder = SubApp("app_builder", app_builder_lifespan)

_store = PydanticStore[OpenSwarmApp](model_cls=OpenSwarmApp, data_dir=APP_BUILDER_METADATA_DIR, not_found_detail="OpenSwarmApp not found")


# ---------------------------------------------------------------------------
# File serving
# ---------------------------------------------------------------------------

@app_builder.router.get("/app/{app_id}/source_dir/{filepath:path}")
async def serve_app_file(app_id: str, filepath: str):
    folder = os.path.join(APP_BUILDER_CONTENT_DIR, app_id)
    full_path = os.path.normpath(os.path.join(folder, filepath))
    if not full_path.startswith(os.path.normpath(folder)):
        raise HTTPException(status_code=403, detail="Path traversal not allowed")
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    with open(full_path) as f:
        content = f.read()
    mime, _ = mimetypes.guess_type(filepath)
    return Response(content=content, media_type=mime or "text/plain")


@app_builder.router.get("/{app_id}/serve/{filepath:path}")
async def serve_app_file(app_id: str, filepath: str):
    folder = os.path.join(APP_BUILDER_CONTENT_DIR, app_id)
    full_path = os.path.normpath(os.path.join(folder, filepath))
    if not full_path.startswith(os.path.normpath(folder)):
        raise HTTPException(status_code=403, detail="Path traversal not allowed")
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found in app")
    with open(full_path) as f:
        content = f.read()
    mime, _ = mimetypes.guess_type(filepath)
    return Response(content=content, media_type=mime or "text/plain")


# ---------------------------------------------------------------------------
# Workspace management
# ---------------------------------------------------------------------------

@app_builder.router.get("/app/{app_id}")
async def read_app(app_id: str):
    folder = os.path.join(APP_BUILDER_CONTENT_DIR, app_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")
    files = walk_directory(folder)
    meta = None
    if "meta.json" in files:
        try:
            meta = json.loads(files["meta.json"])
        except (json.JSONDecodeError, ValueError):
            pass
    return {"files": files, "meta": meta}


class OpenSwarmAppSeedRequest(BaseModel):
    app_id: str
    files: Optional[dict[str, str]] = None
    meta: Optional[dict[str, Any]] = None

@app_builder.router.post("/app/seed")
async def seed_app(body: OpenSwarmAppSeedRequest):
    folder = os.path.join(APP_BUILDER_CONTENT_DIR, body.app_id)
    os.makedirs(folder, exist_ok=True)
    if body.files:
        for rel_path, content in body.files.items():
            full_path = os.path.normpath(os.path.join(folder, rel_path))
            if not full_path.startswith(os.path.normpath(folder)):
                continue
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "w") as f:
                f.write(content)
    else:
        for rel_path, content in APP_BUILDER_TEMPLATE_FILES.items():
            full_path = os.path.join(folder, rel_path)
            with open(full_path, "w") as f:
                f.write(content)
    with open(os.path.join(folder, "SKILL.md"), "w") as f:
        f.write(APP_BUILDER_SKILL)
    if body.meta:
        with open(os.path.join(folder, "meta.json"), "w") as f:
            json.dump(body.meta, f, indent=2)
    return {"path": os.path.abspath(folder)}


@app_builder.router.put("/app/{app_id}/file/{filepath:path}")
async def write_app_file(app_id: str, filepath: str, body: dict):
    folder = os.path.join(APP_BUILDER_CONTENT_DIR, app_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")
    full_path = os.path.normpath(os.path.join(folder, filepath))
    if not full_path.startswith(os.path.normpath(folder)):
        raise HTTPException(status_code=403, detail="Path traversal not allowed")
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "w") as f:
        f.write(body.get("content", ""))
    return {"ok": True}


@app_builder.router.delete("/app/{app_id}/file/{filepath:path}")
async def delete_app_file(app_id: str, filepath: str):
    folder = os.path.join(APP_BUILDER_CONTENT_DIR, app_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")
    full_path = os.path.normpath(os.path.join(folder, filepath))
    if not full_path.startswith(os.path.normpath(folder)):
        raise HTTPException(status_code=403, detail="Path traversal not allowed")
    if os.path.isfile(full_path):
        os.remove(full_path)
        parent = os.path.dirname(full_path)
        while parent != os.path.normpath(folder):
            if os.path.isdir(parent) and not os.listdir(parent):
                os.rmdir(parent)
                parent = os.path.dirname(parent)
            else:
                break
    return {"ok": True}


# ---------------------------------------------------------------------------
# OpenSwarmApp CRUD
# ---------------------------------------------------------------------------

@app_builder.router.get("/list")
async def list_apps():
    return {"apps": [o.model_dump() for o in _store.load_all()]}


@app_builder.router.get("/{app_id}")
async def get_app(app_id: str):
    return _store.load(app_id).model_dump()


class OpenSwarmAppCreate(BaseModel):
    name: str
    description: str = ""
    icon: str = "view_quilt"
    files: Optional[dict[str, str]] = None
    thumbnail: Optional[str] = None

@app_builder.router.post("/create")
async def create_app(body: OpenSwarmAppCreate):
    now = datetime.now().isoformat()
    app = OpenSwarmApp(
        name=body.name, description=body.description, icon=body.icon,
        thumbnail=body.thumbnail, created_at=now, updated_at=now,
    )
    folder = os.path.join(APP_BUILDER_CONTENT_DIR, app.id)
    os.makedirs(folder, exist_ok=True)
    seed_files = body.files if body.files else APP_BUILDER_TEMPLATE_FILES
    for rel_path, content in seed_files.items():
        full_path = os.path.normpath(os.path.join(folder, rel_path))
        if not full_path.startswith(os.path.normpath(folder)):
            continue
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "w") as f:
            f.write(content)
    with open(os.path.join(folder, "SKILL.md"), "w") as f:
        f.write(APP_BUILDER_SKILL)
    _store.save(app)
    return {"ok": True, "app": app.model_dump()}


class OpenSwarmAppUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    thumbnail: Optional[str] = None

@app_builder.router.put("/{app_id}")
async def update_app(app_id: str, body: OpenSwarmAppUpdate):
    app = _store.load(app_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(app, k, v)
    app.updated_at = datetime.now().isoformat()
    _store.save(app)
    return {"ok": True, "app": app.model_dump()}


@app_builder.router.delete("/{app_id}")
async def delete_app(app_id: str):
    folder = os.path.join(APP_BUILDER_CONTENT_DIR, app_id)
    if os.path.isdir(folder):
        shutil.rmtree(folder)
    _store.delete(app_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------

class OpenSwarmAppExecute(BaseModel):
    app_id: str

class OpenSwarmAppExecuteResult(BaseModel):
    app_id: str
    app_name: str
    frontend_code: str
    backend_result: Optional[dict[str, Any]] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    error: Optional[str] = None

def _read_app_file(app_id: str, filename: str) -> Optional[str]:
    path = os.path.join(APP_BUILDER_CONTENT_DIR, app_id, filename)
    if not os.path.isfile(path):
        return None
    with open(path) as f:
        return f.read()

@app_builder.router.post("/execute")
async def execute_app(body: OpenSwarmAppExecute):
    backend_code = _read_app_file(body.app_id, "backend.py")
    backend_result = None
    stdout_text = None
    stderr_text = None
    error = None
    app_name: Optional[str] = json.loads(_read_app_file(body.app_id, "meta.json")).get("name", "")
    assert app_name is not None, "App name is required but not found in meta.json"

    if backend_code:
        try:
            exec_result: BackendExecResult = await execute_backend_code(backend_code)
            backend_result = exec_result.result
            stdout_text = exec_result.stdout
            stderr_text = exec_result.stderr
        except Exception as e:
            error = str(e)

    return OpenSwarmAppExecuteResult(
        app_id=body.app_id, app_name=app_name,
        frontend_code=_read_app_file(body.app_id, "index.html") or "",
        backend_result=backend_result, stdout=stdout_text,
        stderr=stderr_text, error=error,
    ).model_dump()
