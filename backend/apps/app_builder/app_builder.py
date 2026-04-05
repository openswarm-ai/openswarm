"""App Builder SubApp — CRUD, workspace management, file serving, and execution."""

import json
import mimetypes
import os
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import HTTPException
from fastapi.responses import Response

from backend.config.Apps import SubApp
from backend.core.db.PydanticStore import PydanticStore
from backend.apps.app_builder.App import (
    App, AppCreate, AppUpdate, AppExecute, AppExecuteResult,
    WorkspaceSeedRequest,
)
from backend.config.paths import DB_ROOT
from backend.apps.app_builder.executor import execute_backend_code
from backend.apps.app_builder.templates import APP_BUILDER_SKILL, APP_BUILDER_TEMPLATE_FILES
from backend.apps.app_builder.helpers import walk_directory

APP_BUILDER_DIR = os.path.join(DB_ROOT, "app_builder")
APP_BUILDER_WORKSPACE_DIR = os.path.join(APP_BUILDER_DIR, "workspace")

@asynccontextmanager
async def app_builder_lifespan():
    os.makedirs(APP_BUILDER_DIR, exist_ok=True)
    os.makedirs(APP_BUILDER_WORKSPACE_DIR, exist_ok=True)
    yield


app_builder = SubApp("app_builder", app_builder_lifespan)

_store = PydanticStore[App](model_cls=App, data_dir=APP_BUILDER_DIR, not_found_detail="App not found")


# ---------------------------------------------------------------------------
# File serving
# ---------------------------------------------------------------------------

@app_builder.router.get("/workspace/{workspace_id}/serve/{filepath:path}")
async def serve_workspace_file(workspace_id: str, filepath: str):
    folder = os.path.join(APP_BUILDER_WORKSPACE_DIR, workspace_id)
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
    app = _store.load(app_id)
    content = app.files.get(filepath)
    if content is None:
        raise HTTPException(status_code=404, detail="File not found in app")
    mime, _ = mimetypes.guess_type(filepath)
    return Response(content=content, media_type=mime or "text/plain")


# ---------------------------------------------------------------------------
# Workspace management
# ---------------------------------------------------------------------------

@app_builder.router.get("/workspace/{workspace_id}")
async def read_workspace(workspace_id: str):
    folder = os.path.join(APP_BUILDER_WORKSPACE_DIR, workspace_id)
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


@app_builder.router.post("/workspace/seed")
async def seed_workspace(body: WorkspaceSeedRequest):
    folder = os.path.join(APP_BUILDER_WORKSPACE_DIR, body.workspace_id)
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


@app_builder.router.put("/workspace/{workspace_id}/file/{filepath:path}")
async def write_workspace_file(workspace_id: str, filepath: str, body: dict):
    folder = os.path.join(APP_BUILDER_WORKSPACE_DIR, workspace_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")
    full_path = os.path.normpath(os.path.join(folder, filepath))
    if not full_path.startswith(os.path.normpath(folder)):
        raise HTTPException(status_code=403, detail="Path traversal not allowed")
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "w") as f:
        f.write(body.get("content", ""))
    return {"ok": True}


@app_builder.router.delete("/workspace/{workspace_id}/file/{filepath:path}")
async def delete_workspace_file(workspace_id: str, filepath: str):
    folder = os.path.join(APP_BUILDER_WORKSPACE_DIR, workspace_id)
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
# App CRUD
# ---------------------------------------------------------------------------

@app_builder.router.get("/list")
async def list_apps():
    return {"apps": [o.model_dump() for o in _store.load_all()]}


@app_builder.router.get("/{app_id}")
async def get_app(app_id: str):
    return _store.load(app_id).model_dump()


@app_builder.router.post("/create")
async def create_app(body: AppCreate):
    now = datetime.now().isoformat()
    app = App(
        name=body.name, description=body.description, icon=body.icon,
        files=body.files, thumbnail=body.thumbnail,
        created_at=now, updated_at=now,
    )
    _store.save(app)
    return {"ok": True, "app": app.model_dump()}


@app_builder.router.put("/{app_id}")
async def update_app(app_id: str, body: AppUpdate):
    app = _store.load(app_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(app, k, v)
    app.updated_at = datetime.now().isoformat()
    _store.save(app)
    return {"ok": True, "app": app.model_dump()}


@app_builder.router.delete("/{app_id}")
async def delete_app(app_id: str):
    _store.load(app_id)
    _store.delete(app_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------

@app_builder.router.post("/execute")
async def execute_app(body: AppExecute):
    app = _store.load(body.app_id)

    backend_code = app.files.get("backend.py")
    backend_result = None
    stdout_text = None
    stderr_text = None
    error = None
    if backend_code:
        try:
            exec_result = await execute_backend_code(backend_code)
            backend_result = exec_result.result
            stdout_text = exec_result.stdout
            stderr_text = exec_result.stderr
        except Exception as e:
            error = str(e)

    return AppExecuteResult(
        app_id=app.id, app_name=app.name,
        frontend_code=app.files.get("index.html", ""),
        backend_result=backend_result, stdout=stdout_text,
        stderr=stderr_text, error=error,
    ).model_dump()
