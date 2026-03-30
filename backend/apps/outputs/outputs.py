"""Outputs SubApp — CRUD, workspace management, and file serving.

AI-generation endpoints live in ``ai_generation.py``; pure helpers in ``helpers.py``.
"""

from __future__ import annotations

import json
import mimetypes
import os
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import HTTPException
from fastapi.responses import Response

from backend.config.Apps import SubApp
from backend.apps.common.json_store import JsonStore
from backend.apps.outputs.models import (
    Output, OutputCreate, OutputUpdate, OutputExecute, OutputExecuteResult,
    AutoRunConfig, WorkspaceSeedRequest,
)
from backend.apps.outputs.executor import execute_backend_code
from backend.apps.outputs.view_builder_templates import VIEW_BUILDER_SKILL, VIEW_TEMPLATE_FILES
from backend.apps.outputs.helpers import (
    _validate_against_schema, _inject_data_into_html, _decode_data_param, _walk_directory,
)
from backend.apps.outputs import ai_generation
from backend.config.paths import OUTPUTS_DIR as DATA_DIR, OUTPUTS_WORKSPACE_DIR as WORKSPACE_DIR


@asynccontextmanager
async def outputs_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(WORKSPACE_DIR, exist_ok=True)
    yield


outputs = SubApp("outputs", outputs_lifespan)

_store = JsonStore(Output, DATA_DIR, not_found_detail="Output not found")
_load_all = _store.load_all
_save = _store.save
_load = _store.load
load_output = _store.load_or_none


# -- File serving --

@outputs.router.get("/workspace/{workspace_id}/serve/{filepath:path}")
async def serve_workspace_file(workspace_id: str, filepath: str, _d: str = ""):
    folder = os.path.join(WORKSPACE_DIR, workspace_id)
    full_path = os.path.normpath(os.path.join(folder, filepath))
    if not full_path.startswith(os.path.normpath(folder)):
        raise HTTPException(status_code=403, detail="Path traversal not allowed")
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    with open(full_path) as f:
        content = f.read()
    if filepath == "index.html":
        input_json, result_json = _decode_data_param(_d) if _d else ("{}", "null")
        content = _inject_data_into_html(content, input_json, result_json)
    mime, _ = mimetypes.guess_type(filepath)
    return Response(content=content, media_type=mime or "text/plain")


@outputs.router.get("/{output_id}/serve/{filepath:path}")
async def serve_output_file(output_id: str, filepath: str, _d: str = ""):
    output = _load(output_id)
    content = output.files.get(filepath)
    if content is None:
        raise HTTPException(status_code=404, detail="File not found in output")
    if filepath == "index.html":
        input_json, result_json = _decode_data_param(_d) if _d else ("{}", "null")
        content = _inject_data_into_html(content, input_json, result_json)
    mime, _ = mimetypes.guess_type(filepath)
    return Response(content=content, media_type=mime or "text/plain")


# -- CRUD --

@outputs.router.get("/list")
async def list_outputs():
    return {"outputs": [o.model_dump() for o in _load_all()]}


@outputs.router.get("/workspace/{workspace_id}")
async def read_workspace(workspace_id: str):
    folder = os.path.join(WORKSPACE_DIR, workspace_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")
    files = _walk_directory(folder)
    meta = None
    if "meta.json" in files:
        try:
            meta = json.loads(files["meta.json"])
        except (json.JSONDecodeError, ValueError):
            pass
    return {"files": files, "meta": meta}


@outputs.router.post("/workspace/seed")
async def seed_workspace(body: WorkspaceSeedRequest):
    folder = os.path.join(WORKSPACE_DIR, body.workspace_id)
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
        for rel_path, content in VIEW_TEMPLATE_FILES.items():
            full_path = os.path.join(folder, rel_path)
            with open(full_path, "w") as f:
                f.write(content)
    with open(os.path.join(folder, "SKILL.md"), "w") as f:
        f.write(VIEW_BUILDER_SKILL)
    if body.meta:
        with open(os.path.join(folder, "meta.json"), "w") as f:
            json.dump(body.meta, f, indent=2)
    return {"path": os.path.abspath(folder)}


@outputs.router.put("/workspace/{workspace_id}/file/{filepath:path}")
async def write_workspace_file(workspace_id: str, filepath: str, body: dict):
    folder = os.path.join(WORKSPACE_DIR, workspace_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")
    full_path = os.path.normpath(os.path.join(folder, filepath))
    if not full_path.startswith(os.path.normpath(folder)):
        raise HTTPException(status_code=403, detail="Path traversal not allowed")
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "w") as f:
        f.write(body.get("content", ""))
    return {"ok": True}


@outputs.router.delete("/workspace/{workspace_id}/file/{filepath:path}")
async def delete_workspace_file(workspace_id: str, filepath: str):
    folder = os.path.join(WORKSPACE_DIR, workspace_id)
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


@outputs.router.get("/{output_id}")
async def get_output(output_id: str):
    return _load(output_id).model_dump()


@outputs.router.post("/create")
async def create_output(body: OutputCreate):
    now = datetime.now().isoformat()
    output = Output(
        name=body.name, description=body.description, icon=body.icon,
        input_schema=body.input_schema, files=body.files,
        auto_run_config=body.auto_run_config, thumbnail=body.thumbnail,
        created_at=now, updated_at=now,
    )
    _save(output)
    from backend.apps.analytics.collector import record as _analytics
    _analytics("feature.used", {"feature": "view.created"})
    return {"ok": True, "output": output.model_dump()}


@outputs.router.put("/{output_id}")
async def update_output(output_id: str, body: OutputUpdate):
    output = _load(output_id)
    for k, v in body.model_dump(exclude_none=True).items():
        if k == "auto_run_config" and isinstance(v, dict):
            v = AutoRunConfig(**v)
        setattr(output, k, v)
    output.updated_at = datetime.now().isoformat()
    _save(output)
    return {"ok": True, "output": output.model_dump()}


@outputs.router.delete("/{output_id}")
async def delete_output(output_id: str):
    _load(output_id)
    path = os.path.join(DATA_DIR, f"{output_id}.json")
    if os.path.exists(path):
        os.remove(path)
    return {"ok": True}


@outputs.router.post("/execute")
async def execute_output(body: OutputExecute):
    output = _load(body.output_id)
    validation_err = _validate_against_schema(body.input_data, output.input_schema)
    if validation_err:
        return OutputExecuteResult(
            output_id=output.id, output_name=output.name,
            frontend_code=output.frontend_code, input_data=body.input_data,
            backend_result=None, error=validation_err,
        ).model_dump()
    backend_result = None
    stdout_text = None
    stderr_text = None
    error = None
    if output.backend_code:
        try:
            exec_result = await execute_backend_code(output.backend_code, body.input_data)
            backend_result = exec_result.result
            stdout_text = exec_result.stdout
            stderr_text = exec_result.stderr
        except Exception as e:
            error = str(e)
    return OutputExecuteResult(
        output_id=output.id, output_name=output.name,
        frontend_code=output.frontend_code, input_data=body.input_data,
        backend_result=backend_result, stdout=stdout_text,
        stderr=stderr_text, error=error,
    ).model_dump()


# -- AI generation routes --
outputs.router.add_api_route("/vibe-code", ai_generation.vibe_code, methods=["POST"])
outputs.router.add_api_route("/auto-run", ai_generation.auto_run_output, methods=["POST"])
outputs.router.add_api_route("/auto-run-agent", ai_generation.auto_run_agent, methods=["POST"])
outputs.router.add_api_route("/auto-run-agent/{session_id}", ai_generation.cleanup_auto_run_agent, methods=["DELETE"])
