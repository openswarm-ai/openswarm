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
    VibeCodeRequest, AutoRunRequest, AutoRunConfig, AutoRunAgentRequest,
    WorkspaceSeedRequest,
)
from backend.apps.outputs.executor import execute_backend_code
from backend.apps.outputs.view_builder_templates import VIEW_BUILDER_SKILL, VIEW_TEMPLATE_FILES
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


def _build_data_injection(input_json: str, result_json: str) -> str:
    """Build a <script> tag that sets OUTPUT_INPUT / OUTPUT_BACKEND_RESULT
    and listens for postMessage updates."""
    return (
        "<script>\n"
        "(function() {\n"
        "  window.OUTPUT_INPUT = " + input_json + ";\n"
        "  window.OUTPUT_BACKEND_RESULT = " + result_json + ";\n"
        "  window.addEventListener('message', function(e) {\n"
        "    if (e.data && e.data.type === 'OUTPUT_DATA') {\n"
        "      window.OUTPUT_INPUT = e.data.input || {};\n"
        "      window.OUTPUT_BACKEND_RESULT = e.data.backendResult || null;\n"
        "      window.dispatchEvent(new CustomEvent('output-data-ready'));\n"
        "    }\n"
        "  });\n"
        "})();\n"
        "</script>"
    )


def _inject_data_into_html(html: str, input_json: str = "{}", result_json: str = "null") -> str:
    injection = _build_data_injection(input_json, result_json)
    if "</head>" in html:
        return html.replace("</head>", f"{injection}\n</head>", 1)
    if "<body" in html:
        return html.replace("<body", f"{injection}\n<body", 1)
    return f"{injection}\n{html}"


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
        content = _inject_data_into_html(content, input_json, result_json)
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
        content = _inject_data_into_html(content, input_json, result_json)
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
    """Create a workspace folder and optionally pre-seed it with files."""
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
        auto_run_config=body.auto_run_config,
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


AUTO_RUN_SYSTEM_PROMPT = """\
You generate structured JSON data matching a given schema.
The user provides a prompt describing what data to generate and a JSON Schema.
Return ONLY valid JSON that conforms to the schema. No markdown fences, no extra text, no explanation.
Every required field must be present. Use realistic, meaningful data.\
"""


@outputs.router.post("/auto-run")
async def auto_run_output(body: AutoRunRequest):
    """Use an LLM to generate input data matching the schema, then optionally execute backend code."""
    try:
        import anthropic
    except ImportError:
        return {"error": "anthropic SDK not installed", "input_data": None, "backend_result": None}

    schema_str = json.dumps(body.input_schema, indent=2)
    user_message = f"Schema:\n```json\n{schema_str}\n```\n\nGenerate data for: {body.prompt}"

    # Resolve body.model via the registry so non-Anthropic selections are
    # routed through 9Router with the correct prefix (cx/, gc/).
    # If body.model is unset or unknown, fall back to whichever aux model
    # is available (prefers Claude, else any connected subscription).
    from backend.apps.agents.providers.registry import (
        _find_builtin_model,
        resolve_model_id_for_sdk,
        resolve_aux_model,
    )
    settings = load_settings()
    if body.model and _find_builtin_model(body.model) is not None:
        api_model = resolve_model_id_for_sdk(body.model, settings)
    else:
        try:
            api_model, _ = await resolve_aux_model(settings, preferred_tier="haiku")
        except ValueError as e:
            return {"error": str(e), "input_data": None, "backend_result": None}

    client = _get_anthropic_client(api_model)
    try:
        resp = await client.messages.create(
            model=api_model,
            max_tokens=4000,
            system=AUTO_RUN_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )
        from backend.apps.agents.agent_manager import _safe_resp_text
        raw = _safe_resp_text(resp).strip()
        if not raw:
            return {"error": "Aux model returned no content.", "input_data": None, "backend_result": None}
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw[:-3]

        input_data = json.loads(raw)

        validation_err = _validate_against_schema(input_data, body.input_schema)
        if validation_err:
            return {"input_data": input_data, "backend_result": None, "error": validation_err}

        backend_result = None
        stdout_text = None
        stderr_text = None
        error = None
        if body.backend_code:
            try:
                exec_result = await execute_backend_code(body.backend_code, input_data)
                backend_result = exec_result.result
                stdout_text = exec_result.stdout
                stderr_text = exec_result.stderr
            except Exception as e:
                error = str(e)

        return {"input_data": input_data, "backend_result": backend_result, "stdout": stdout_text, "stderr": stderr_text, "error": error}
    except json.JSONDecodeError:
        return {"error": "Failed to parse generated data as JSON", "input_data": None, "backend_result": None}
    except Exception as e:
        logger.exception("Auto-run failed")
        return {"error": str(e), "input_data": None, "backend_result": None}


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


AUTO_RUN_AGENT_SYSTEM_PROMPT = """\
You are a data-gathering agent. Your job is to use the available tools to collect \
real data, then render it into a structured View.

You have access to MCP tools (e.g. Gmail, calendar, etc.) that let you fetch live data. \
Use them as needed to fulfil the user's request.

When you have gathered enough data, call the **RenderOutput** tool with:
- `output_id`: `{output_id}`
- `input_data`: a JSON object conforming to this schema:
```json
{schema}
```

Do NOT fabricate data. Use the tools to get real information, then structure it to match \
the schema above. If a tool call fails, report the error clearly.\
"""


@outputs.router.post("/auto-run-agent")
async def auto_run_agent(body: AutoRunAgentRequest):
    """Launch a temporary agent session that uses MCP tools to gather data for a view."""
    from backend.apps.agents.agent_manager import agent_manager, FULL_TOOLS
    from backend.apps.agents.models import AgentConfig

    output = _load(body.output_id)
    schema_str = json.dumps(body.input_schema or output.input_schema, indent=2)

    system_prompt = AUTO_RUN_AGENT_SYSTEM_PROMPT.format(
        output_id=body.output_id,
        schema=schema_str,
    )

    allowed_tools = list(FULL_TOOLS)
    for tool_name in body.forced_tools:
        if tool_name not in allowed_tools:
            allowed_tools.append(tool_name)

    config = AgentConfig(
        name=f"AutoRun: {output.name}",
        model=body.model,
        mode="agent",
        system_prompt=system_prompt,
        allowed_tools=allowed_tools,
        max_turns=20,
    )

    session = await agent_manager.launch_agent(config)

    await agent_manager.send_message(
        session.id,
        body.prompt,
        context_paths=body.context_paths if body.context_paths else None,
        forced_tools=body.forced_tools if body.forced_tools else None,
    )

    return {"session_id": session.id}


@outputs.router.delete("/auto-run-agent/{session_id}")
async def cleanup_auto_run_agent(session_id: str):
    """Delete a temporary auto-run agent session."""
    from backend.apps.agents.agent_manager import agent_manager

    try:
        await agent_manager.delete_session(session_id)
    except Exception as e:
        logger.warning(f"Auto-run agent cleanup failed for {session_id}: {e}")
    return {"ok": True}
