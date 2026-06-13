import json
import os
import logging
import mimetypes
from datetime import datetime
from typing import Optional
from contextlib import asynccontextmanager
from fastapi import HTTPException, Query
from fastapi.responses import Response
from backend.auth import get_auth_token
from backend.config.Apps import SubApp
from backend.apps.outputs.models import (
    Output, OutputCreate, OutputUpdate, OutputExecute, OutputExecuteResult,
    VibeCodeRequest, WorkspaceSeedRequest,
)
from backend.apps.outputs.executor import execute_backend_code, get_code_warnings
from backend.apps.outputs.view_builder_templates import (
    VIEW_TEMPLATE_FILES,
    load_app_builder_skill,
    seed_webapp_template_workspace,
)
from backend.apps.settings.settings import load_settings
from backend.config.paths import OUTPUTS_DIR as DATA_DIR, OUTPUTS_WORKSPACE_DIR as WORKSPACE_DIR
from backend.apps.outputs.html_inject import (
    MODEL_MAP,
    _resolve_model,
    _get_anthropic_client,
    _validate_against_schema,
    _build_data_injection,
    _inject_data_into_html,
    _backend_url_for_workspace,
    _inject_token_into_relative_urls,
    _decode_data_param,
)
from backend.apps.outputs.workspace_io import (
    _load_all,
    _save,
    _load,
    load_output,
    _walk_directory,
)
from backend.apps.outputs.prompts import VIBE_CODE_SYSTEM_PROMPT

logger = logging.getLogger(__name__)


@asynccontextmanager
async def outputs_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(WORKSPACE_DIR, exist_ok=True)
    try:
        yield
    finally:
        # Reap every per-app subprocess. Without this each `bash run.sh`
        # (and its vite/uvicorn descendants) reparents to PID 1 when the
        # main backend dies, leaving ghost listeners on the .env-pinned
        # ports that block the next OpenSwarm launch's reload preview.
        try:
            from backend.apps.outputs.runtime import manager as runtime_manager
            killed = await runtime_manager.stop_all()
            if killed:
                logger.info("outputs lifespan: reaped %d workspace runtimes on shutdown", killed)
        except Exception:
            logger.exception("outputs lifespan: stop_all failed")


outputs = SubApp("outputs", outputs_lifespan)


# ---------------------------------------------------------------------------
# File-serving endpoints (for iframe preview with multi-file support)
# ---------------------------------------------------------------------------

@outputs.router.get("/workspace/{workspace_id}/serve/{filepath:path}")
async def serve_workspace_file(workspace_id: str, filepath: str, _d: str = ""):
    """Serve a file from a workspace folder. For index.html, inject OUTPUT data."""
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
        backend_url_json = _backend_url_for_workspace(workspace_id)
        content = _inject_data_into_html(content, input_json, result_json, backend_url_json)
        # Iframe sub-resource fetches (<link>, <script src>, <img>) drop the
        # parent's ?token= query string, so rewrite the HTML to put the token
        # back on every relative URL; otherwise sub-resources 401.
        content = _inject_token_into_relative_urls(content, get_auth_token())

    mime, _ = mimetypes.guess_type(filepath)
    return Response(content=content, media_type=mime or "text/plain")


@outputs.router.get("/{output_id}/serve/{filepath:path}")
async def serve_output_file(output_id: str, filepath: str, _d: str = ""):
    """Serve a file from a saved output's files dict. For index.html, inject OUTPUT data."""
    output = _load(output_id)
    content = output.files.get(filepath)
    if content is None:
        raise HTTPException(status_code=404, detail="File not found in output")

    if filepath == "index.html":
        input_json, result_json = _decode_data_param(_d) if _d else ("{}", "null")
        backend_url_json = _backend_url_for_workspace(output.workspace_id) if output.workspace_id else "null"
        content = _inject_data_into_html(content, input_json, result_json, backend_url_json)
        content = _inject_token_into_relative_urls(content, get_auth_token())

    mime, _ = mimetypes.guess_type(filepath)
    return Response(content=content, media_type=mime or "text/plain")


# ---------------------------------------------------------------------------
# CRUD + workspace endpoints
# ---------------------------------------------------------------------------

@outputs.router.get("/list")
async def list_outputs():
    return {"outputs": [o.model_dump() for o in _load_all()]}


@outputs.router.get("/workspace/{workspace_id}")
async def read_workspace(workspace_id: str):
    """Read all files from an output workspace folder."""
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

    # Include `path` so the frontend can rehydrate without re-calling /seed.
    # /seed unconditionally overwrites, which would clobber any in-progress edits
    # the agent made since the last save.
    return {"files": files, "meta": meta, "path": os.path.abspath(folder)}


def sync_output_from_meta_json(workspace_id: str, fallback_name: str | None = None) -> bool:
    """Sync the Output row's name/description from meta.json (or fallback_name when
    meta.json has no name). Only overwrites placeholder values; user renames win."""
    try:
        folder = os.path.join(WORKSPACE_DIR, workspace_id)
        meta_path = os.path.join(folder, "meta.json")
        name = ""
        description = ""
        if os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    meta = json.load(f)
                if isinstance(meta, dict):
                    name = str(meta.get("name") or "").strip()
                    description = str(meta.get("description") or "").strip()
            except (OSError, json.JSONDecodeError, ValueError):
                pass
        if not name and fallback_name:
            name = str(fallback_name).strip()
        if not name and not description:
            return False
        matching = [o for o in _load_all() if o.workspace_id == workspace_id]
        if not matching:
            return False
        output = matching[0]
        changed = False
        if name and output.name in ("", "Untitled App") and output.name != name:
            output.name = name
            changed = True
        if description and not output.description and output.description != description:
            output.description = description
            changed = True
        if changed:
            output.updated_at = datetime.now().isoformat()
            _save(output)
        return changed
    except Exception:
        logger.exception("sync_output_from_meta_json failed for %s", workspace_id)
        return False


def ensure_webapp_workspace_seeded_and_registered(
    workspace_id: str,
    folder: str,
    session_id: Optional[str] = None,
) -> Optional[str]:
    """Idempotently seed the webapp template into `folder` and register an
    Output row pointing at `workspace_id`. Used by the canvas-chat launch
    path so picking "App Builder" from the mode dropdown produces the same
    sidebar visibility as the Apps editor's `/workspace/seed` flow.

    When `session_id` is supplied, it is persisted on the Output row so the
    Apps editor can reattach to the same chat history later (without this
    link, double-clicking the app card opens an empty editor instead of
    the conversation the user already had with the agent).

    Idempotency:
      - If `run.sh` already exists in the folder, skip the template copy
        (matches the seed_workspace endpoint's idempotency guard).
      - If any Output already points at this workspace_id, reuse it but
        still attach session_id if it's missing.
    Returns the output_id on success, None on failure (best-effort; the
    caller's session still launches even if registration fails).
    """
    try:
        os.makedirs(folder, exist_ok=True)
        already_seeded = os.path.exists(os.path.join(folder, "run.sh"))
        if not already_seeded:
            from backend.apps.outputs.runtime import _find_free_port
            frontend_port = _find_free_port()
            seed_webapp_template_workspace(folder, frontend_port)
            with open(os.path.join(folder, "SKILL.md"), "w", encoding="utf-8") as f:
                f.write(load_app_builder_skill())
        existing = [o for o in _load_all() if o.workspace_id == workspace_id]
        if existing:
            output = existing[0]
            if session_id and output.session_id != session_id:
                output.session_id = session_id
                output.updated_at = datetime.now().isoformat()
                _save(output)
            return output.id
        now = datetime.now().isoformat()
        output = Output(
            name="Untitled App",
            description="",
            icon="view_quilt",
            files={},
            workspace_id=workspace_id,
            session_id=session_id,
            created_at=now,
            updated_at=now,
        )
        _save(output)
        return output.id
    except Exception:
        logger.exception("ensure_webapp_workspace_seeded_and_registered failed for %s", workspace_id)
        return None


@outputs.router.post("/workspace/seed")
async def seed_workspace(body: WorkspaceSeedRequest):
    """Create a workspace folder and pre-seed it.

    Two seeding modes:

    - **`template_mode="flat"`** (current default): writes the legacy
      VIEW_TEMPLATE_FILES (single index.html + meta.json + schema.json).
      Used by every workspace created so far. Runtime spawns
      `python -u backend.py` (if present) and the preview pane fetches
      from `/api/outputs/workspace/{ws}/serve/...`.

    - **`template_mode="webapp_template"`**: copies the vendored
      openswarm-ai/webapp-template snapshot (React + Vite + TS frontend
      with an optional FastAPI backend) into the workspace, allocates a
      free FRONTEND_PORT and writes it into both `.env` and
      `.env.example`. BACKEND_PORT stays NONE; the agent opts in with
      `bash backend_init.sh`. Runtime spawn flips to `bash run.sh` and
      the preview pane points at `http://localhost:{FRONTEND_PORT}/`.
      `body.files` is ignored in this mode; the snapshot is the source
      of truth.
    """
    folder = os.path.join(WORKSPACE_DIR, body.workspace_id)
    os.makedirs(folder, exist_ok=True)

    # An explicit non-empty `files` payload means the caller has flat-mode
    # content to write (a saved legacy Output being reseeded). Don't
    # clobber that with the React template even if template_mode is the
    # new default; the migration helper has its own path for that.
    effective_mode = body.template_mode
    if body.files:
        effective_mode = "flat"

    if effective_mode == "webapp_template":
        # Idempotency guard: re-seeding an existing webapp_template
        # workspace would clobber the agent's edits (the helper uses
        # dirs_exist_ok=True + copytree). If `run.sh` already exists,
        # the workspace was seeded on a previous visit; skip the file
        # copy and only re-derive the frontend port from .env.
        from backend.apps.outputs.runtime import _find_free_port, _read_env_value
        already_seeded = os.path.exists(os.path.join(folder, "run.sh"))
        if already_seeded:
            fp_raw = _read_env_value(os.path.join(folder, ".env"), "FRONTEND_PORT")
            try:
                frontend_port = int(fp_raw) if fp_raw else _find_free_port()
            except (TypeError, ValueError):
                frontend_port = _find_free_port()
        else:
            frontend_port = _find_free_port()
            seed_webapp_template_workspace(folder, frontend_port)
            # SKILL.md still goes in workspace root; agent reads it for
            # context. Live content (user-editable via Skills page) is
            # injected into the system prompt regardless.
            with open(os.path.join(folder, "SKILL.md"), "w", encoding="utf-8") as f:
                f.write(load_app_builder_skill())
        meta = body.meta or {}
        if body.meta and not already_seeded:
            with open(os.path.join(folder, "meta.json"), "w", encoding="utf-8") as f:
                json.dump(body.meta, f, indent=2)
        # Create (or look up) the Output record so the app appears in
        # the Apps sidebar the moment the user kicks off generation.
        # Previously the record only landed when the editor's autosave
        # fired, which itself was gated on `files['index.html']` being
        # non-empty (a flat-template invariant); meaning React+Vite
        # apps that navigated-away mid-build had no way back. The record
        # is a thin pointer (name + workspace_id); the workspace itself
        # remains the source of truth for the code.
        output_id: Optional[str] = None
        try:
            existing = [o for o in _load_all() if o.workspace_id == body.workspace_id]
            if existing:
                output_id = existing[0].id
            else:
                now = datetime.now().isoformat()
                output = Output(
                    name=str(meta.get("name") or "Untitled App"),
                    description=str(meta.get("description") or ""),
                    icon="view_quilt",
                    files={},
                    workspace_id=body.workspace_id,
                    created_at=now,
                    updated_at=now,
                )
                _save(output)
                output_id = output.id
        except Exception:
            logger.exception("seed-time Output create failed for %s", body.workspace_id)
        return {
            "path": os.path.abspath(folder),
            "template_mode": "webapp_template",
            "frontend_port": frontend_port,
            "output_id": output_id,
            "already_seeded": already_seeded,
        }

    # Legacy flat path; unchanged.
    if body.files:
        for rel_path, content in body.files.items():
            full_path = os.path.normpath(os.path.join(folder, rel_path))
            if not full_path.startswith(os.path.normpath(folder)):
                continue
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(content)
    else:
        for rel_path, content in VIEW_TEMPLATE_FILES.items():
            full_path = os.path.join(folder, rel_path)
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(content)

    # Seed the workspace's SKILL.md with the LIVE skill content so an
    # agent that Reads SKILL.md sees the same text the Skills page shows.
    # Snapshot at workspace creation; subsequent edits don't rewrite
    # already-seeded workspaces (the system-prompt injection in
    # agent_manager reads live, so the agent always has the latest
    # rules regardless of this on-disk copy).
    with open(os.path.join(folder, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(load_app_builder_skill())

    if body.meta:
        with open(os.path.join(folder, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(body.meta, f, indent=2)

    return {"path": os.path.abspath(folder), "template_mode": "flat"}


# ---------------------------------------------------------------------------
# Persistent app-backend runtime control. backend.py runs as a long-lived
# subprocess for the lifetime of the App being open; auto-allocated port,
# log streaming via WebSocket. See runtime.py for the manager.
# ---------------------------------------------------------------------------


def _runtime_status_payload(workspace_id: str) -> dict:
    from backend.apps.outputs.runtime import manager as runtime_manager
    from backend.apps.outputs.runtime import _is_new_mode
    rt = runtime_manager.get(workspace_id)
    if not rt:
        # Even without a live runtime, the editor needs is_new_mode to
        # decide whether the preview pane should fall back to the legacy
        # /serve/index.html URL (old-mode flat workspaces) or show the
        # "starting preview…" placeholder (new-mode webapp_template).
        # Compute from disk so a failed runtime/start still gives the
        # client the right hint instead of dumping it onto a 404.
        folder = os.path.join(WORKSPACE_DIR, workspace_id)
        is_new = _is_new_mode(folder) if os.path.isdir(folder) else False
        return {
            "running": False,
            "port": None,
            "has_backend_file": False,
            "backend_url": None,
            "frontend_port": None,
            "frontend_url": None,
            "is_new_mode": is_new,
        }
    return {
        "running": rt.running,
        "port": rt.port,
        "has_backend_file": rt.has_backend_file,
        # For old-mode: backend.py serves; backend_url is its port. For
        # new-mode: backend.py is optional (gated by BACKEND_PORT!=NONE);
        # only populated if the agent ran bash backend_init.sh.
        "backend_url": f"http://127.0.0.1:{rt.port}" if rt.running and rt.port else None,
        # New-mode only: where the Vite dev server is reachable.
        # Old-mode workspaces report null and the editor falls back to
        # the legacy /api/outputs/workspace/{ws}/serve/... path.
        "frontend_port": rt.frontend_port,
        "frontend_url": rt.frontend_url if rt.running else None,
        "is_new_mode": rt.is_new_mode,
    }


@outputs.router.post("/workspace/{workspace_id}/runtime/start")
async def runtime_start(workspace_id: str):
    folder = os.path.join(WORKSPACE_DIR, workspace_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")
    from backend.apps.outputs.runtime import manager as runtime_manager
    await runtime_manager.attach(workspace_id, os.path.abspath(folder))
    return _runtime_status_payload(workspace_id)


@outputs.router.post("/workspace/{workspace_id}/runtime/stop")
async def runtime_stop(workspace_id: str):
    from backend.apps.outputs.runtime import manager as runtime_manager
    await runtime_manager.detach(workspace_id)
    return _runtime_status_payload(workspace_id)


@outputs.router.post("/workspace/{workspace_id}/runtime/restart")
async def runtime_restart(workspace_id: str):
    folder = os.path.join(WORKSPACE_DIR, workspace_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")
    from backend.apps.outputs.runtime import manager as runtime_manager
    # Restart only if something's attached; otherwise this is a no-op
    # silently (a hard-reload click while the runtime was already torn
    # down; we'd rather not silently respawn an orphan).
    rt = runtime_manager.get(workspace_id)
    if rt:
        await runtime_manager.restart(workspace_id, os.path.abspath(folder))
    return _runtime_status_payload(workspace_id)


@outputs.router.get("/workspace/{workspace_id}/runtime/status")
async def runtime_get_status(workspace_id: str):
    return _runtime_status_payload(workspace_id)


@outputs.router.post("/shutdown-all")
async def runtime_shutdown_all():
    """Reap every workspace subprocess. Electron POSTs this during
    will-quit so app subprocesses die BEFORE the main backend gets
    SIGTERM'd; without it `bash run.sh` + its vite/uvicorn descendants
    reparent to PID 1 and squat on .env-pinned ports forever."""
    from backend.apps.outputs.runtime import manager as runtime_manager
    killed = await runtime_manager.stop_all()
    return {"ok": True, "killed": killed}


@outputs.router.put("/workspace/{workspace_id}/file/{filepath:path}")
async def write_workspace_file(workspace_id: str, filepath: str, body: dict):
    """Write (create/overwrite) a single file in a workspace."""
    folder = os.path.join(WORKSPACE_DIR, workspace_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")
    folder_norm = os.path.normpath(folder)
    full_path = os.path.normpath(os.path.join(folder, filepath))
    # `startswith(folder_norm + os.sep)` (not just folder_norm) so a workspace
    # `abc-123` can't be tricked into writing into a sibling `abc-1234-evil` , 
    # prefix-string collision rather than path-component containment. Today's
    # UUID-format ids make the collision unlikely in practice, but the check
    # is one character and immunizes future id schemes.
    if full_path != folder_norm and not full_path.startswith(folder_norm + os.sep):
        raise HTTPException(status_code=403, detail="Path traversal not allowed")
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "w", encoding="utf-8") as f:
        f.write(body.get("content", ""))
    return {"ok": True}


@outputs.router.delete("/workspace/{workspace_id}/file/{filepath:path}")
async def delete_workspace_file(workspace_id: str, filepath: str):
    """Delete a single file from a workspace."""
    folder = os.path.join(WORKSPACE_DIR, workspace_id)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail="Workspace not found")
    folder_norm = os.path.normpath(folder)
    full_path = os.path.normpath(os.path.join(folder, filepath))
    if full_path != folder_norm and not full_path.startswith(folder_norm + os.sep):
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
        name=body.name,
        description=body.description,
        icon=body.icon,
        input_schema=body.input_schema,
        files=body.files,
        thumbnail=body.thumbnail,
        created_at=now,
        updated_at=now,
    )
    _save(output)
    pass
    return {"ok": True, "output": output.model_dump()}


@outputs.router.put("/{output_id}")
async def update_output(output_id: str, body: OutputUpdate):
    output = _load(output_id)
    # exclude_unset, NOT exclude_none: a PUT that explicitly sends session_id=null
    # (the Apps stale-link self-heal) must clear the field. exclude_none silently
    # dropped that null, so the dead pointer never cleared and the app 404'd on
    # every open, forever. Unset fields stay untouched; only what the client sent applies.
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(output, k, v)
    now = datetime.now().isoformat()
    output.updated_at = now
    # Only a real screenshot write moves the sort key; files/linkage saves don't reorder.
    if body.thumbnail is not None:
        output.preview_updated_at = now
    _save(output)
    return {"ok": True, "output": output.model_dump()}


@outputs.router.delete("/{output_id}")
async def delete_output(output_id: str):
    _load(output_id)
    path = os.path.join(DATA_DIR, f"{output_id}.json")
    if os.path.exists(path):
        os.remove(path)
    return {"ok": True}


@outputs.router.post("/vibe-code")
async def vibe_code(body: VibeCodeRequest):
    """Use an LLM to generate or iterate on Output code from a natural language prompt."""
    try:
        import anthropic
    except ImportError:
        return {
            "message": "anthropic SDK not installed. Install with: pip install anthropic",
            "frontend_code": body.current_frontend_code,
            "backend_code": body.current_backend_code,
            "input_schema": body.current_schema,
        }

    context_parts = []
    if body.current_frontend_code:
        context_parts.append(f"Current frontend code:\n```html\n{body.current_frontend_code}\n```")
    if body.current_backend_code:
        context_parts.append(f"Current backend code:\n```python\n{body.current_backend_code}\n```")
    if body.current_schema:
        context_parts.append(f"Current input schema:\n```json\n{body.current_schema}\n```")
    if body.name:
        context_parts.append(f"Current name: {body.name}")
    if body.description:
        context_parts.append(f"Current description: {body.description}")

    user_message = body.prompt
    if context_parts:
        user_message = "\n\n".join(context_parts) + "\n\nUser request: " + body.prompt

    from backend.apps.agents.providers.registry import resolve_aux_model
    try:
        aux_model, _aux_base = await resolve_aux_model(load_settings(), preferred_tier="sonnet")
    except ValueError as e:
        return {
            "message": f"Error: {str(e)}",
            "frontend_code": body.current_frontend_code,
            "backend_code": body.current_backend_code,
            "input_schema": body.current_schema,
        }
    client = _get_anthropic_client(aux_model)
    try:
        resp = await client.messages.create(
            model=aux_model,
            max_tokens=8000,
            system=VIBE_CODE_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )
        from backend.apps.agents.core.aux_llm import _safe_resp_text
        raw = _safe_resp_text(resp).strip()
        if not raw:
            return {
                "message": "Aux model returned no content. Please try again.",
                "frontend_code": body.current_frontend_code,
                "backend_code": body.current_backend_code,
                "input_schema": body.current_schema,
            }
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw[:-3]

        result = json.loads(raw)
        pass
        return {
            "message": result.get("message", "View updated."),
            "frontend_code": result.get("frontend_code", body.current_frontend_code),
            "backend_code": result.get("backend_code", body.current_backend_code),
            "input_schema": result.get("input_schema", body.current_schema),
            "name": result.get("name", body.name),
            "description": result.get("description", body.description),
        }
    except json.JSONDecodeError:
        return {
            "message": "I generated code but couldn't parse the response. Please try again.",
            "frontend_code": body.current_frontend_code,
            "backend_code": body.current_backend_code,
            "input_schema": body.current_schema,
        }
    except Exception as e:
        logger.exception("Vibe code generation failed")
        return {
            "message": f"Error: {str(e)}",
            "frontend_code": body.current_frontend_code,
            "backend_code": body.current_backend_code,
            "input_schema": body.current_schema,
        }


@outputs.router.post("/execute")
async def execute_output(body: OutputExecute):
    output = _load(body.output_id)

    validation_err = _validate_against_schema(body.input_data, output.input_schema)
    if validation_err:
        return OutputExecuteResult(
            output_id=output.id,
            output_name=output.name,
            frontend_code=output.frontend_code,
            input_data=body.input_data,
            backend_result=None,
            error=validation_err,
        ).model_dump()

    backend_result = None
    stdout_text = None
    stderr_text = None
    error = None
    warnings_out: Optional[list[str]] = None
    code_preview: Optional[str] = None
    if output.backend_code:
        # HITL gate: collect warnings up front. If the caller hasn't opted
        # in via force=True AND the code touches anything outside the safe
        # allowlist, return the warnings + the code itself so the UI can
        # show a preview dialog. No subprocess is spawned on this path , 
        # zero-cost when warnings exist, identical-to-before when they
        # don't.
        if not body.force:
            warnings_out = get_code_warnings(output.backend_code)
            if warnings_out:
                code_preview = output.backend_code
        if not warnings_out:
            try:
                # We've either already vetted (no warnings above) or the
                # user explicitly opted in with force=True. Pass
                # skip_validation=True so we don't pay for a redundant
                # AST walk inside execute_backend_code.
                exec_result = await execute_backend_code(
                    output.backend_code, body.input_data, skip_validation=True
                )
                backend_result = exec_result.result
                stdout_text = exec_result.stdout
                stderr_text = exec_result.stderr
            except Exception as e:
                error = str(e)

    return OutputExecuteResult(
        output_id=output.id,
        output_name=output.name,
        frontend_code=output.frontend_code,
        input_data=body.input_data,
        backend_result=backend_result,
        stdout=stdout_text,
        stderr=stderr_text,
        error=error,
        warnings=warnings_out if warnings_out else None,
        code_preview=code_preview,
    ).model_dump()


