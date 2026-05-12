import json
import os
import re
import logging
import mimetypes
import base64
from datetime import datetime
from contextlib import asynccontextmanager
from fastapi import HTTPException, Query
from fastapi.responses import Response
from backend.auth import get_auth_token
from jsonschema import validate as schema_validate, ValidationError as SchemaValidationError
from backend.config.Apps import SubApp
from backend.apps.outputs.models import (
    Output, OutputCreate, OutputUpdate, OutputExecute, OutputExecuteResult,
    VibeCodeRequest, WorkspaceSeedRequest,
)
from backend.apps.outputs.executor import execute_backend_code
from backend.apps.outputs.view_builder_templates import (
    VIEW_TEMPLATE_FILES,
    load_app_builder_skill,
    seed_webapp_template_workspace,
)
from backend.apps.settings.settings import load_settings

logger = logging.getLogger(__name__)

MODEL_MAP = {
    "sonnet": "claude-sonnet-4-20250514",
    "opus": "claude-opus-4-20250514",
    "haiku": "claude-haiku-4-5-20251001",
}


def _resolve_model(short_name: str) -> str:
    return MODEL_MAP.get(short_name, short_name)


def _get_anthropic_client(api_model: str | None = None):
    """Create an AsyncAnthropic client using the API key from app settings.

    When `api_model` is provided and carries a 9Router prefix (cc/, cx/, gc/),
    the client is pointed at 9Router so non-Anthropic aux calls don't 400 on
    api.anthropic.com. Without an api_model we fall back to the default
    connection-mode-driven client.
    """
    from backend.apps.settings.credentials import (
        get_anthropic_client,
        get_anthropic_client_for_model,
    )
    settings = load_settings()
    if api_model:
        return get_anthropic_client_for_model(settings, api_model)
    return get_anthropic_client(settings)


def _validate_against_schema(data: dict, schema: dict) -> str | None:
    """Validate *data* against *schema*. Return an error string or None."""
    try:
        schema_validate(instance=data, schema=schema)
        return None
    except SchemaValidationError as exc:
        path = " -> ".join(str(p) for p in exc.absolute_path) if exc.absolute_path else "(root)"
        return f"Schema validation failed at {path}: {exc.message}"

from backend.config.paths import OUTPUTS_DIR as DATA_DIR, OUTPUTS_WORKSPACE_DIR as WORKSPACE_DIR


def _build_data_injection(input_json: str, result_json: str, backend_url_json: str = "null") -> str:
    """Build a <script> tag that sets OUTPUT_INPUT / OUTPUT_BACKEND_RESULT /
    OUTPUT_BACKEND_URL and listens for postMessage updates.

    OUTPUT_BACKEND_URL is `null` when the app has no live `backend.py`
    process; otherwise it's `http://localhost:<port>` and app code can
    `fetch(window.OUTPUT_BACKEND_URL + '/route')` to hit the persistent
    backend's endpoints."""
    return (
        "<script>\n"
        "(function() {\n"
        "  window.OUTPUT_INPUT = " + input_json + ";\n"
        "  window.OUTPUT_BACKEND_RESULT = " + result_json + ";\n"
        "  window.OUTPUT_BACKEND_URL = " + backend_url_json + ";\n"
        "  window.addEventListener('message', function(e) {\n"
        "    if (e.data && e.data.type === 'OUTPUT_DATA') {\n"
        "      window.OUTPUT_INPUT = e.data.input || {};\n"
        "      window.OUTPUT_BACKEND_RESULT = e.data.backendResult || null;\n"
        "      if (e.data.backendUrl !== undefined) window.OUTPUT_BACKEND_URL = e.data.backendUrl;\n"
        "      window.dispatchEvent(new CustomEvent('output-data-ready'));\n"
        "    }\n"
        "  });\n"
        "})();\n"
        "</script>"
    )


def _inject_data_into_html(html: str, input_json: str = "{}", result_json: str = "null", backend_url_json: str = "null") -> str:
    injection = _build_data_injection(input_json, result_json, backend_url_json)
    if "</head>" in html:
        return html.replace("</head>", f"{injection}\n</head>", 1)
    if "<body" in html:
        return html.replace("<body", f"{injection}\n<body", 1)
    return f"{injection}\n{html}"


def _backend_url_for_workspace(workspace_id: str) -> str:
    """Return the JSON-encoded backend URL for the given workspace, or
    "null" if no runtime is active. Cheap inline lookup so serve_workspace_file
    doesn't have to think about it."""
    try:
        from backend.apps.outputs.runtime import manager as runtime_manager
        rt = runtime_manager.get(workspace_id)
        if rt and rt.running and rt.port:
            return json.dumps(f"http://127.0.0.1:{rt.port}")
    except Exception:
        logger.exception("backend url lookup failed for %s", workspace_id)
    return "null"


# URL schemes / prefixes that must NOT have ?token= appended. These are either
# external (CDNs, mailto) or non-network references that the auth middleware
# never sees. Anything else is treated as a same-origin relative URL pointing
# at our /api/outputs/.../serve/ subtree, which DOES need the token.
_ABSOLUTE_URL_PREFIXES = (
    "http://", "https://", "//", "data:", "blob:",
    "mailto:", "tel:", "javascript:", "about:", "#",
)

_HREF_SRC_ATTR_RE = re.compile(
    r"""(\s(?:href|src))\s*=\s*(["'])([^"']+)\2""",
    re.IGNORECASE,
)


def _inject_token_into_relative_urls(html: str, token: str) -> str:
    """Append `?token=<t>` to every relative href/src in the served HTML.

    Browsers strip the parent iframe URL's query string before resolving
    relative `<link href="styles.css">` / `<script src="x.js">`, so without
    this rewrite the sub-resource fetch lands at the auth middleware with no
    credentials and gets a 401. Idempotent: skips URLs that already carry a
    `token=` param. Skips absolute URLs (CDN, data:, etc.) — see prefix list.
    """
    if not token:
        return html

    def _patch(match: re.Match) -> str:
        attr, quote, url = match.group(1), match.group(2), match.group(3)
        lowered = url.lower().lstrip()
        if lowered.startswith(_ABSOLUTE_URL_PREFIXES):
            return match.group(0)
        if "token=" in url:
            return match.group(0)
        # Split off any hash fragment so `?token=` lands in the query, not in
        # the fragment: `page.html?v=1#sec` → `page.html?v=1&token=X#sec`.
        hash_idx = url.find("#")
        if hash_idx >= 0:
            base, frag = url[:hash_idx], url[hash_idx:]
        else:
            base, frag = url, ""
        sep = "&" if "?" in base else "?"
        return f'{attr}={quote}{base}{sep}token={token}{frag}{quote}'

    return _HREF_SRC_ATTR_RE.sub(_patch, html)


def _decode_data_param(d: str) -> tuple[str, str]:
    """Decode the base64-encoded _d query param into (input_json, result_json)."""
    try:
        decoded = json.loads(base64.b64decode(d))
        input_json = json.dumps(decoded.get("i", {}))
        result_json = json.dumps(decoded.get("r", None))
        return input_json, result_json
    except Exception:
        return "{}", "null"


@asynccontextmanager
async def outputs_lifespan():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(WORKSPACE_DIR, exist_ok=True)
    yield


outputs = SubApp("outputs", outputs_lifespan)


def _load_all() -> list[Output]:
    result = []
    if not os.path.exists(DATA_DIR):
        return result
    for fname in os.listdir(DATA_DIR):
        if fname.endswith(".json"):
            with open(os.path.join(DATA_DIR, fname)) as f:
                result.append(Output(**json.load(f)))
    return result


def _save(output: Output):
    with open(os.path.join(DATA_DIR, f"{output.id}.json"), "w") as f:
        json.dump(output.model_dump(), f, indent=2)


def _load(output_id: str) -> Output:
    path = os.path.join(DATA_DIR, f"{output_id}.json")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Output not found")
    with open(path) as f:
        return Output(**json.load(f))


def load_output(output_id: str) -> Output | None:
    """Public helper for other modules to resolve an output by ID."""
    path = os.path.join(DATA_DIR, f"{output_id}.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return Output(**json.load(f))


def _walk_directory(folder: str) -> dict[str, str]:
    """Walk a directory tree and return {relative_path: content} for all text files."""
    files: dict[str, str] = {}
    if not os.path.isdir(folder):
        return files
    for root, _dirs, filenames in os.walk(folder):
        for fname in filenames:
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, folder)
            try:
                with open(full_path) as f:
                    files[rel_path] = f.read()
            except Exception:
                pass
    return files


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
        # back on every relative URL — otherwise sub-resources 401.
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
      `.env.example`. BACKEND_PORT stays NONE — the agent opts in with
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
    # new default — the migration helper has its own path for that.
    effective_mode = body.template_mode
    if body.files:
        effective_mode = "flat"

    if effective_mode == "webapp_template":
        # Defer to the helper — copytree, env scaffolding, install paths.
        from backend.apps.outputs.runtime import _find_free_port
        frontend_port = _find_free_port()
        seed_webapp_template_workspace(folder, frontend_port)
        # SKILL.md still goes in workspace root — agent reads it for
        # context. Live content (user-editable via Skills page) is
        # injected into the system prompt regardless.
        with open(os.path.join(folder, "SKILL.md"), "w") as f:
            f.write(load_app_builder_skill())
        if body.meta:
            with open(os.path.join(folder, "meta.json"), "w") as f:
                json.dump(body.meta, f, indent=2)
        return {"path": os.path.abspath(folder), "template_mode": "webapp_template", "frontend_port": frontend_port}

    # Legacy flat path — unchanged.
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

    # Seed the workspace's SKILL.md with the LIVE skill content so an
    # agent that Reads SKILL.md sees the same text the Skills page shows.
    # Snapshot at workspace creation; subsequent edits don't rewrite
    # already-seeded workspaces (the system-prompt injection in
    # agent_manager reads live, so the agent always has the latest
    # rules regardless of this on-disk copy).
    with open(os.path.join(folder, "SKILL.md"), "w") as f:
        f.write(load_app_builder_skill())

    if body.meta:
        with open(os.path.join(folder, "meta.json"), "w") as f:
            json.dump(body.meta, f, indent=2)

    return {"path": os.path.abspath(folder), "template_mode": "flat"}


# ---------------------------------------------------------------------------
# Persistent app-backend runtime control. backend.py runs as a long-lived
# subprocess for the lifetime of the App being open; auto-allocated port,
# log streaming via WebSocket. See runtime.py for the manager.
# ---------------------------------------------------------------------------


def _runtime_status_payload(workspace_id: str) -> dict:
    from backend.apps.outputs.runtime import manager as runtime_manager
    rt = runtime_manager.get(workspace_id)
    if not rt:
        return {
            "running": False,
            "port": None,
            "has_backend_file": False,
            "backend_url": None,
            "frontend_port": None,
            "frontend_url": None,
            "is_new_mode": False,
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
    # down — we'd rather not silently respawn an orphan).
    rt = runtime_manager.get(workspace_id)
    if rt:
        await runtime_manager.restart(workspace_id, os.path.abspath(folder))
    return _runtime_status_payload(workspace_id)


@outputs.router.get("/workspace/{workspace_id}/runtime/status")
async def runtime_get_status(workspace_id: str):
    return _runtime_status_payload(workspace_id)


@outputs.router.put("/workspace/{workspace_id}/file/{filepath:path}")
async def write_workspace_file(workspace_id: str, filepath: str, body: dict):
    """Write (create/overwrite) a single file in a workspace."""
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
    """Delete a single file from a workspace."""
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
    for k, v in body.model_dump(exclude_none=True).items():
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


VIBE_CODE_SYSTEM_PROMPT = """\
You are an expert at building self-contained HTML/JS/CSS applications that run in an iframe.

The user will describe what they want, and you will generate:
1. **frontend_code**: A complete HTML document. React 18 is available via esm.sh CDN.
   - Use: <script type="importmap">{"imports":{"react":"https://esm.sh/react@18","react-dom/client":"https://esm.sh/react-dom@18/client"}}</script>
   - Input data is at window.OUTPUT_INPUT (object), backend result at window.OUTPUT_BACKEND_RESULT.
2. **input_schema**: A JSON Schema object defining the structured input.
3. **backend_code** (optional): Python code where input_data is a global dict and result is a global dict to assign to.
4. **name**: A short name for the view.
5. **description**: A one-sentence description.
6. **message**: A brief explanation of what you did/changed.

Return ONLY valid JSON with these keys. No markdown fences, no extra text.\
"""


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
        from backend.apps.agents.agent_manager import _safe_resp_text
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
    if output.backend_code:
        try:
            exec_result = await execute_backend_code(
                output.backend_code, body.input_data
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
    ).model_dump()


