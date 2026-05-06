"""Integration tests for /api/outputs.

Boots the real FastAPI app through the shared `client` fixture so every
route exercises auth middleware + lifespan. Anthropic + the model
registry are monkeypatched per-test for the LLM-driven endpoints. The
agent_manager-spawning endpoint reuses the existing `stub_agent_loop`
fixture so the real `launch_agent` runs (creating an in-memory session)
without spawning the SDK.

Layout mirrors `outputs.py`:
  - CRUD (/list, /create, /{id}, PUT, DELETE) + legacy migration
  - Workspace seed / read / write / delete
  - File serve (workspace + saved output, with token rewrite + _d
    payload injection)
  - Backend execute
  - auto-run (LLM-mocked)
  - auto-run-agent (stub_agent_loop + AgentConfig spy)
  - Auth control mirroring test_api_agents.test_protected_route_requires_auth
"""

from __future__ import annotations

import base64
import json
import os
import sys

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_output(client, **overrides) -> dict:
    """POST /create with sensible defaults, return the persisted output dict."""
    payload = {
        "name": "Test Output",
        "description": "test",
        "input_schema": {
            "type": "object",
            "properties": {"x": {"type": "integer"}},
            "required": ["x"],
        },
        "files": {"index.html": "<html><head></head><body></body></html>"},
    }
    payload.update(overrides)
    resp = client.post("/api/outputs/create", json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()["output"]


# ---------------------------------------------------------------------------
# CRUD + legacy migration
# ---------------------------------------------------------------------------


def test_list_empty_on_fresh_dir(client):
    resp = client.get("/api/outputs/list")
    assert resp.status_code == 200
    assert resp.json() == {"outputs": []}


def test_create_get_update_delete_round_trip(client):
    created = _create_output(client, name="Alpha")
    output_id = created["id"]
    assert created["name"] == "Alpha"

    listed = client.get("/api/outputs/list").json()["outputs"]
    assert any(o["id"] == output_id for o in listed)

    fetched = client.get(f"/api/outputs/{output_id}")
    assert fetched.status_code == 200
    assert fetched.json()["name"] == "Alpha"

    upd = client.put(
        f"/api/outputs/{output_id}",
        json={
            "name": "Beta",
            "auto_run_config": {
                "enabled": True,
                "prompt": "fetch X",
                "mode": "agent",
                "model": "sonnet",
            },
        },
    )
    assert upd.status_code == 200
    body = upd.json()["output"]
    assert body["name"] == "Beta"
    assert body["auto_run_config"]["enabled"] is True
    assert body["auto_run_config"]["prompt"] == "fetch X"

    deleted = client.delete(f"/api/outputs/{output_id}")
    assert deleted.status_code == 200

    from backend.config.paths import OUTPUTS_DIR
    assert not os.path.exists(os.path.join(OUTPUTS_DIR, f"{output_id}.json"))

    gone = client.get(f"/api/outputs/{output_id}")
    assert gone.status_code == 404


def test_get_unknown_output_returns_404(client):
    resp = client.get("/api/outputs/does-not-exist")
    assert resp.status_code == 404


def test_create_migrates_legacy_frontend_backend_code(client):
    resp = client.post(
        "/api/outputs/create",
        json={
            "name": "Legacy",
            "frontend_code": "<html>old</html>",
            "backend_code": "result = {}",
        },
    )
    assert resp.status_code == 200
    output = resp.json()["output"]
    assert output["files"]["index.html"] == "<html>old</html>"
    assert output["files"]["backend.py"] == "result = {}"


def test_update_unknown_output_returns_404(client):
    resp = client.put("/api/outputs/missing", json={"name": "x"})
    assert resp.status_code == 404


def test_delete_unknown_output_returns_404(client):
    resp = client.delete("/api/outputs/missing")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Workspace seed
# ---------------------------------------------------------------------------


def test_workspace_seed_with_explicit_files(client):
    from backend.config.paths import OUTPUTS_WORKSPACE_DIR

    workspace_id = "ws-explicit"
    resp = client.post(
        "/api/outputs/workspace/seed",
        json={
            "workspace_id": workspace_id,
            "files": {
                "index.html": "<html>seeded</html>",
                "schema.json": '{"type":"object"}',
            },
            "meta": {"name": "X", "description": "y"},
        },
    )
    assert resp.status_code == 200

    folder = os.path.join(OUTPUTS_WORKSPACE_DIR, workspace_id)
    assert os.path.isfile(os.path.join(folder, "index.html"))
    assert os.path.isfile(os.path.join(folder, "schema.json"))
    assert os.path.isfile(os.path.join(folder, "SKILL.md"))

    with open(os.path.join(folder, "meta.json")) as f:
        meta = json.load(f)
    assert meta["name"] == "X"


def test_workspace_seed_empty_uses_default_template(client):
    from backend.apps.outputs.view_builder_templates import VIEW_TEMPLATE_FILES
    from backend.config.paths import OUTPUTS_WORKSPACE_DIR

    workspace_id = "ws-default"
    resp = client.post(
        "/api/outputs/workspace/seed",
        json={"workspace_id": workspace_id},
    )
    assert resp.status_code == 200

    folder = os.path.join(OUTPUTS_WORKSPACE_DIR, workspace_id)
    for rel_path in VIEW_TEMPLATE_FILES:
        assert os.path.isfile(os.path.join(folder, rel_path)), rel_path
    assert os.path.isfile(os.path.join(folder, "SKILL.md"))


def test_workspace_seed_drops_path_traversal_keys(client):
    """Keys that escape the workspace folder via `..` are silently
    skipped (continue branch in seed_workspace)."""
    from backend.config.paths import OUTPUTS_WORKSPACE_DIR

    workspace_id = "ws-traversal"
    resp = client.post(
        "/api/outputs/workspace/seed",
        json={
            "workspace_id": workspace_id,
            "files": {
                "ok.txt": "kept",
                "../escape.html": "should-not-write",
            },
        },
    )
    assert resp.status_code == 200

    folder = os.path.join(OUTPUTS_WORKSPACE_DIR, workspace_id)
    assert os.path.isfile(os.path.join(folder, "ok.txt"))
    parent = os.path.dirname(os.path.normpath(folder))
    assert not os.path.exists(os.path.join(parent, "escape.html"))


# ---------------------------------------------------------------------------
# Workspace read
# ---------------------------------------------------------------------------


def test_workspace_read_returns_files_and_meta(client):
    workspace_id = "ws-read"
    client.post(
        "/api/outputs/workspace/seed",
        json={
            "workspace_id": workspace_id,
            "files": {"index.html": "<html/>"},
            "meta": {"name": "Read me"},
        },
    )

    resp = client.get(f"/api/outputs/workspace/{workspace_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["files"]["index.html"] == "<html/>"
    assert body["meta"] == {"name": "Read me"}
    assert body["path"].endswith(workspace_id)


def test_workspace_read_returns_none_meta_for_bad_meta_json(client):
    """Garbage meta.json triggers the JSONDecodeError swallow branch
    in `read_workspace`, returning meta=None."""
    from backend.config.paths import OUTPUTS_WORKSPACE_DIR

    workspace_id = "ws-bad-meta"
    folder = os.path.join(OUTPUTS_WORKSPACE_DIR, workspace_id)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, "meta.json"), "w") as f:
        f.write("{not valid json")

    resp = client.get(f"/api/outputs/workspace/{workspace_id}")
    assert resp.status_code == 200
    assert resp.json()["meta"] is None


def test_workspace_read_missing_returns_404(client):
    resp = client.get("/api/outputs/workspace/does-not-exist")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Workspace file write / delete
# ---------------------------------------------------------------------------


def test_workspace_write_and_delete_file(client):
    from backend.config.paths import OUTPUTS_WORKSPACE_DIR

    workspace_id = "ws-write"
    client.post("/api/outputs/workspace/seed", json={"workspace_id": workspace_id})

    write = client.put(
        f"/api/outputs/workspace/{workspace_id}/file/sub/dir/app.css",
        json={"content": "body { color: red; }"},
    )
    assert write.status_code == 200
    assert write.json() == {"ok": True}

    full = os.path.join(OUTPUTS_WORKSPACE_DIR, workspace_id, "sub", "dir", "app.css")
    assert os.path.isfile(full)

    delete = client.delete(f"/api/outputs/workspace/{workspace_id}/file/sub/dir/app.css")
    assert delete.status_code == 200
    assert not os.path.exists(full)
    # Empty parent dirs collapse up to the workspace root.
    assert not os.path.exists(os.path.join(OUTPUTS_WORKSPACE_DIR, workspace_id, "sub"))


def test_workspace_write_traversal_rejected(client):
    workspace_id = "ws-write-trav"
    client.post("/api/outputs/workspace/seed", json={"workspace_id": workspace_id})

    resp = client.put(
        f"/api/outputs/workspace/{workspace_id}/file/..%2Fescape.html",
        json={"content": "x"},
    )
    assert resp.status_code == 403


def test_workspace_write_missing_workspace_404(client):
    resp = client.put(
        "/api/outputs/workspace/missing/file/foo.txt",
        json={"content": "x"},
    )
    assert resp.status_code == 404


def test_workspace_delete_traversal_rejected(client):
    workspace_id = "ws-del-trav"
    client.post("/api/outputs/workspace/seed", json={"workspace_id": workspace_id})

    resp = client.delete(f"/api/outputs/workspace/{workspace_id}/file/..%2Fescape.html")
    assert resp.status_code == 403


def test_workspace_delete_missing_workspace_404(client):
    resp = client.delete("/api/outputs/workspace/missing/file/foo.txt")
    assert resp.status_code == 404


def test_workspace_delete_missing_file_is_idempotent(client):
    """DELETE on an existing workspace but missing file still returns
    {"ok": True} (no-op branch)."""
    workspace_id = "ws-del-idem"
    client.post("/api/outputs/workspace/seed", json={"workspace_id": workspace_id})

    resp = client.delete(f"/api/outputs/workspace/{workspace_id}/file/nope.txt")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


# ---------------------------------------------------------------------------
# Serve endpoints
# ---------------------------------------------------------------------------


def test_workspace_serve_non_html_is_raw(client):
    workspace_id = "ws-serve-css"
    client.post(
        "/api/outputs/workspace/seed",
        json={
            "workspace_id": workspace_id,
            "files": {"app.css": "body { color: red; }"},
        },
    )
    resp = client.get(f"/api/outputs/workspace/{workspace_id}/serve/app.css")
    assert resp.status_code == 200
    assert resp.text == "body { color: red; }"
    assert resp.headers["content-type"].startswith("text/css")


def test_workspace_serve_index_html_injects_default_globals(client, auth_token):
    workspace_id = "ws-serve-html"
    html = (
        '<html><head><title>x</title>'
        '<link href="styles.css">'
        '<script src="https://cdn.example/lib.js"></script>'
        "</head><body></body></html>"
    )
    client.post(
        "/api/outputs/workspace/seed",
        json={"workspace_id": workspace_id, "files": {"index.html": html}},
    )

    resp = client.get(f"/api/outputs/workspace/{workspace_id}/serve/index.html")
    assert resp.status_code == 200
    body = resp.text
    assert "window.OUTPUT_INPUT = {}" in body
    assert "window.OUTPUT_BACKEND_RESULT = null" in body
    # Relative <link> got the token; absolute <script src=https://...> did not.
    assert f'href="styles.css?token={auth_token}"' in body
    assert 'src="https://cdn.example/lib.js"' in body


def test_workspace_serve_index_html_decodes_d_param(client):
    workspace_id = "ws-serve-d"
    html = "<html><head></head><body></body></html>"
    client.post(
        "/api/outputs/workspace/seed",
        json={"workspace_id": workspace_id, "files": {"index.html": html}},
    )

    payload = {"i": {"k": 1}, "r": {"v": 2}}
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()

    resp = client.get(
        f"/api/outputs/workspace/{workspace_id}/serve/index.html",
        params={"_d": encoded},
    )
    assert resp.status_code == 200
    body = resp.text
    assert 'window.OUTPUT_INPUT = {"k": 1}' in body
    assert 'window.OUTPUT_BACKEND_RESULT = {"v": 2}' in body


def test_workspace_serve_traversal_rejected(client):
    workspace_id = "ws-serve-trav"
    client.post("/api/outputs/workspace/seed", json={"workspace_id": workspace_id})

    resp = client.get(f"/api/outputs/workspace/{workspace_id}/serve/..%2Fescape.html")
    assert resp.status_code == 403


def test_workspace_serve_missing_file_returns_404(client):
    workspace_id = "ws-serve-404"
    client.post("/api/outputs/workspace/seed", json={"workspace_id": workspace_id})

    resp = client.get(f"/api/outputs/workspace/{workspace_id}/serve/nope.txt")
    assert resp.status_code == 404


def test_output_serve_index_html_injects_globals(client, auth_token):
    html = (
        '<html><head><link href="extra.css"></head><body></body></html>'
    )
    output = _create_output(client, files={"index.html": html, "extra.css": "x{}"})

    resp = client.get(f"/api/outputs/{output['id']}/serve/index.html")
    assert resp.status_code == 200
    body = resp.text
    assert "window.OUTPUT_INPUT" in body
    assert f'href="extra.css?token={auth_token}"' in body


def test_output_serve_non_html_raw(client):
    output = _create_output(
        client,
        files={"index.html": "<html/>", "data.json": '{"k":1}'},
    )
    resp = client.get(f"/api/outputs/{output['id']}/serve/data.json")
    assert resp.status_code == 200
    assert resp.text == '{"k":1}'


def test_output_serve_missing_file_returns_404(client):
    output = _create_output(client)
    resp = client.get(f"/api/outputs/{output['id']}/serve/nope.html")
    assert resp.status_code == 404


def test_output_serve_unknown_output_returns_404(client):
    resp = client.get("/api/outputs/does-not-exist/serve/index.html")
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# /execute
# ---------------------------------------------------------------------------


def test_execute_schema_invalid_input(client):
    output = _create_output(client)
    resp = client.post(
        "/api/outputs/execute",
        json={"output_id": output["id"], "input_data": {"x": "not-an-int"}},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["error"] is not None
    assert "Schema validation failed" in body["error"]
    assert body["backend_result"] is None


def test_execute_runs_backend_code(client):
    output = _create_output(
        client,
        files={
            "index.html": "<html/>",
            "backend.py": "result['double'] = input_data['x'] * 2",
        },
    )
    resp = client.post(
        "/api/outputs/execute",
        json={"output_id": output["id"], "input_data": {"x": 21}},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["backend_result"] == {"double": 42}
    assert body["error"] is None


def test_execute_captures_stdout(client):
    output = _create_output(
        client,
        files={
            "index.html": "<html/>",
            "backend.py": "print('hi'); result['ok'] = True",
        },
    )
    resp = client.post(
        "/api/outputs/execute",
        json={"output_id": output["id"], "input_data": {"x": 1}},
    )
    body = resp.json()
    assert "hi" in (body["stdout"] or "")
    assert body["backend_result"] == {"ok": True}


def test_execute_backend_raise_populates_error(client):
    output = _create_output(
        client,
        files={
            "index.html": "<html/>",
            "backend.py": "raise RuntimeError('boom')",
        },
    )
    resp = client.post(
        "/api/outputs/execute",
        json={"output_id": output["id"], "input_data": {"x": 1}},
    )
    body = resp.json()
    assert body["error"] is not None
    assert body["backend_result"] is None


def test_execute_no_backend_code_returns_none_result(client):
    output = _create_output(client, files={"index.html": "<html/>"})
    resp = client.post(
        "/api/outputs/execute",
        json={"output_id": output["id"], "input_data": {"x": 1}},
    )
    body = resp.json()
    assert body["backend_result"] is None
    assert body["error"] is None


# ---------------------------------------------------------------------------
# /auto-run (Anthropic mocked)
# ---------------------------------------------------------------------------


def test_auto_run_resolver_value_error(client, monkeypatch):
    from backend.apps.agents.providers import registry

    async def _raise(_settings, preferred_tier="haiku"):
        raise ValueError("no aux model")

    monkeypatch.setattr(registry, "resolve_aux_model", _raise)
    # Ensure builtin lookup misses so route falls into resolve_aux_model.
    monkeypatch.setattr(registry, "_find_builtin_model", lambda _name: None)

    resp = client.post(
        "/api/outputs/auto-run",
        json={"prompt": "x", "input_schema": {"type": "object"}, "model": "unknown"},
    )
    body = resp.json()
    assert "no aux model" in body["error"]
    assert body["input_data"] is None


def test_auto_run_anthropic_import_error(client, monkeypatch):
    monkeypatch.setitem(sys.modules, "anthropic", None)
    resp = client.post(
        "/api/outputs/auto-run",
        json={"prompt": "x", "input_schema": {"type": "object"}},
    )
    body = resp.json()
    assert "anthropic SDK not installed" in body["error"]
    assert body["input_data"] is None


# ---------------------------------------------------------------------------
# /auto-run-agent (stub_agent_loop + AgentConfig spy)
# ---------------------------------------------------------------------------


def test_auto_run_agent_assembles_config_and_forwards_prompt(
    client, stub_agent_loop, monkeypatch,
):
    """Use a spy around `launch_agent` so we can assert the AgentConfig
    that the route built (including the merged forced_tools list,
    which `launch_agent` itself ignores in favor of the mode roster)."""
    from backend.apps.agents import agent_manager as am_mod

    output = _create_output(client, name="MyView")

    captured: list = []
    real_launch = am_mod.agent_manager.launch_agent

    async def _spy(config):
        captured.append(config)
        return await real_launch(config)

    monkeypatch.setattr(am_mod.agent_manager, "launch_agent", _spy)

    resp = client.post(
        "/api/outputs/auto-run-agent",
        json={
            "prompt": "go gather data",
            "output_id": output["id"],
            "model": "sonnet",
            "forced_tools": ["customMcp__fetchEmail"],
            "input_schema": {"type": "object", "properties": {"k": {"type": "integer"}}},
        },
    )
    assert resp.status_code == 200
    session_id = resp.json()["session_id"]

    assert len(captured) == 1
    cfg = captured[0]
    assert cfg.name == f"AutoRun: {output['name']}"
    assert cfg.mode == "agent"
    assert cfg.model == "sonnet"
    assert output["id"] in (cfg.system_prompt or "")
    assert '"k"' in (cfg.system_prompt or "")
    # forced_tools not in FULL_TOOLS get appended onto allowed_tools.
    assert "customMcp__fetchEmail" in cfg.allowed_tools

    session = am_mod.agent_manager.sessions[session_id]
    assert session.name == f"AutoRun: {output['name']}"
    assert any(m.role == "user" and m.content == "go gather data" for m in session.messages)


def test_auto_run_agent_uses_output_schema_when_request_omits_one(
    client, stub_agent_loop, monkeypatch,
):
    from backend.apps.agents import agent_manager as am_mod

    output = _create_output(
        client,
        input_schema={
            "type": "object",
            "properties": {"slot": {"type": "string"}},
        },
    )

    captured: list = []
    real_launch = am_mod.agent_manager.launch_agent

    async def _spy(config):
        captured.append(config)
        return await real_launch(config)

    monkeypatch.setattr(am_mod.agent_manager, "launch_agent", _spy)

    # Body omits `input_schema` (defaults to {}); route should fall back
    # to `output.input_schema`.
    resp = client.post(
        "/api/outputs/auto-run-agent",
        json={"prompt": "go", "output_id": output["id"]},
    )
    assert resp.status_code == 200
    cfg = captured[0]
    assert '"slot"' in (cfg.system_prompt or "")


def test_auto_run_agent_unknown_output_returns_404(client, stub_agent_loop):
    resp = client.post(
        "/api/outputs/auto-run-agent",
        json={"prompt": "x", "output_id": "missing"},
    )
    assert resp.status_code == 404


def test_cleanup_auto_run_agent_deletes_session(client, stub_agent_loop):
    output = _create_output(client)
    launched = client.post(
        "/api/outputs/auto-run-agent",
        json={"prompt": "x", "output_id": output["id"]},
    )
    session_id = launched.json()["session_id"]

    from backend.apps.agents import agent_manager as am_mod
    assert session_id in am_mod.agent_manager.sessions

    resp = client.delete(f"/api/outputs/auto-run-agent/{session_id}")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert session_id not in am_mod.agent_manager.sessions


def test_cleanup_auto_run_agent_swallows_delete_errors(client, monkeypatch):
    """If `delete_session` raises, the route still returns ok:True
    after logging a warning. Covers the try/except branch."""
    from backend.apps.agents import agent_manager as am_mod

    async def _raise(_session_id):
        raise RuntimeError("boom")

    monkeypatch.setattr(am_mod.agent_manager, "delete_session", _raise)

    resp = client.delete("/api/outputs/auto-run-agent/some-id")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


# ---------------------------------------------------------------------------
# Auth control (mirrors test_api_agents.test_protected_route_requires_auth)
# ---------------------------------------------------------------------------


def test_protected_route_requires_auth(app, tmp_data_dirs):
    from fastapi.testclient import TestClient

    with TestClient(app) as tc:
        resp = tc.get("/api/outputs/list")
    assert resp.status_code == 401
