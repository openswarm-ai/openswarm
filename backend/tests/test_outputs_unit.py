"""Unit tests for the outputs subapp helpers, models, and executor.

These exercise pure logic and pydantic models without booting FastAPI.
The integration surface (routes) lives in `test_api_outputs.py`.

Covers:
  - outputs.py helpers: _resolve_model, _validate_against_schema,
    _build_data_injection, _inject_data_into_html,
    _inject_token_into_relative_urls (every branch in
    _ABSOLUTE_URL_PREFIXES + token-already-present + fragment),
    _decode_data_param, _walk_directory.
  - On-disk store helpers: _save / _load / load_output / _load_all.
  - Models: legacy `frontend_code` / `backend_code` / `schema_json`
    migration into `files`, plus the property accessors.
  - executor.execute_backend_code: happy path, stdout capture,
    syntax + runtime errors, timeout (TIMEOUT_SECONDS monkeypatched),
    non-JSON output JSONDecodeError branch.
"""

from __future__ import annotations

import base64
import json
import os

import pytest
from fastapi import HTTPException

from backend.apps.outputs import outputs as outputs_mod
from backend.apps.outputs.outputs import (
    _ABSOLUTE_URL_PREFIXES,
    _build_data_injection,
    _decode_data_param,
    _inject_data_into_html,
    _inject_token_into_relative_urls,
    _load,
    _load_all,
    _resolve_model,
    _save,
    _validate_against_schema,
    _walk_directory,
    load_output,
    MODEL_MAP,
)
from backend.apps.outputs.models import (
    AutoRunConfig,
    Output,
    OutputCreate,
    OutputUpdate,
    WorkspaceSeedRequest,
)
from backend.apps.outputs.executor import (
    BackendExecResult,
    execute_backend_code,
)


# ---------------------------------------------------------------------------
# _resolve_model
# ---------------------------------------------------------------------------


def test_resolve_model_known_short_name():
    assert _resolve_model("sonnet") == MODEL_MAP["sonnet"]
    assert _resolve_model("opus") == MODEL_MAP["opus"]
    assert _resolve_model("haiku") == MODEL_MAP["haiku"]


def test_resolve_model_unknown_passthrough():
    assert _resolve_model("claude-3-5-haiku") == "claude-3-5-haiku"
    assert _resolve_model("") == ""


# ---------------------------------------------------------------------------
# _validate_against_schema
# ---------------------------------------------------------------------------


def test_validate_against_schema_valid_returns_none():
    schema = {
        "type": "object",
        "properties": {"x": {"type": "integer"}},
        "required": ["x"],
    }
    assert _validate_against_schema({"x": 1}, schema) is None


def test_validate_against_schema_nested_path_in_error():
    schema = {
        "type": "object",
        "properties": {
            "a": {"type": "object", "properties": {"b": {"type": "integer"}}}
        },
    }
    err = _validate_against_schema({"a": {"b": "not-int"}}, schema)
    assert err is not None
    assert "a -> b" in err
    assert "Schema validation failed" in err


def test_validate_against_schema_root_level_error():
    """When absolute_path is empty (root-level type mismatch), the
    formatter substitutes '(root)'."""
    schema = {"type": "object"}
    err = _validate_against_schema(["not-an-object"], schema)
    assert err is not None
    assert "(root)" in err


# ---------------------------------------------------------------------------
# _build_data_injection / _inject_data_into_html
# ---------------------------------------------------------------------------


def test_build_data_injection_includes_globals_and_listener():
    out = _build_data_injection('{"a":1}', "null")
    assert "window.OUTPUT_INPUT = " + '{"a":1}' in out
    assert "window.OUTPUT_BACKEND_RESULT = null" in out
    assert "addEventListener('message'" in out
    assert "OUTPUT_DATA" in out


def test_inject_data_into_html_before_head_close():
    html = "<html><head><title>x</title></head><body></body></html>"
    out = _inject_data_into_html(html, '{"k":1}', "null")
    head_idx = out.index("</head>")
    assert "window.OUTPUT_INPUT" in out[:head_idx]


def test_inject_data_into_html_falls_back_to_body():
    html = "<html><body><p>x</p></body></html>"
    out = _inject_data_into_html(html, "{}", "null")
    body_idx = out.index("<body")
    assert "window.OUTPUT_INPUT" in out[:body_idx]


def test_inject_data_into_html_falls_back_to_prepend():
    html = "<p>plain</p>"
    out = _inject_data_into_html(html, "{}", "null")
    assert out.startswith("<script>")
    assert out.endswith(html)


def test_inject_data_into_html_default_args():
    """Default JSON values are valid base64-decoded payloads."""
    out = _inject_data_into_html("<html></html>")
    assert "window.OUTPUT_INPUT = {}" in out
    assert "window.OUTPUT_BACKEND_RESULT = null" in out


# ---------------------------------------------------------------------------
# _inject_token_into_relative_urls
# ---------------------------------------------------------------------------


def test_inject_token_relative_href_and_src():
    html = '<link href="styles.css"><script src="app.js"></script>'
    out = _inject_token_into_relative_urls(html, "tok123")
    assert 'href="styles.css?token=tok123"' in out
    assert 'src="app.js?token=tok123"' in out


def test_inject_token_appends_with_amp_when_query_present():
    html = '<script src="app.js?v=1"></script>'
    out = _inject_token_into_relative_urls(html, "tok")
    assert 'src="app.js?v=1&token=tok"' in out


def test_inject_token_preserves_fragment():
    html = '<link href="page.html?v=1#sec">'
    out = _inject_token_into_relative_urls(html, "tok")
    assert 'href="page.html?v=1&token=tok#sec"' in out


def test_inject_token_preserves_fragment_no_query():
    html = '<link href="page.html#sec">'
    out = _inject_token_into_relative_urls(html, "tok")
    assert 'href="page.html?token=tok#sec"' in out


@pytest.mark.parametrize("prefix", _ABSOLUTE_URL_PREFIXES)
def test_inject_token_skips_absolute_urls(prefix):
    """Every prefix in _ABSOLUTE_URL_PREFIXES must be left untouched."""
    url = f"{prefix}foo"
    html = f'<script src="{url}"></script>'
    out = _inject_token_into_relative_urls(html, "tok")
    assert f'src="{url}"' in out
    assert "token=tok" not in out


def test_inject_token_skips_urls_with_existing_token():
    html = '<link href="styles.css?token=existing">'
    out = _inject_token_into_relative_urls(html, "newtok")
    assert 'href="styles.css?token=existing"' in out
    assert "newtok" not in out


def test_inject_token_noop_when_token_empty():
    html = '<link href="styles.css">'
    assert _inject_token_into_relative_urls(html, "") == html


def test_inject_token_handles_single_quotes():
    html = "<link href='styles.css'>"
    out = _inject_token_into_relative_urls(html, "tok")
    assert "styles.css?token=tok" in out


def test_inject_token_requires_whitespace_before_attr():
    """The regex matches `\\shref=...`, so attr-like substrings without
    leading whitespace are NOT touched (defensive: no false positives in
    user-supplied JSON / inline scripts)."""
    html = 'data-href="x.css"'
    out = _inject_token_into_relative_urls(html, "tok")
    assert out == html


# ---------------------------------------------------------------------------
# _decode_data_param
# ---------------------------------------------------------------------------


def test_decode_data_param_round_trip():
    payload = {"i": {"k": 1}, "r": {"v": 2}}
    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
    input_json, result_json = _decode_data_param(encoded)
    assert json.loads(input_json) == {"k": 1}
    assert json.loads(result_json) == {"v": 2}


def test_decode_data_param_missing_keys_default():
    encoded = base64.b64encode(b"{}").decode()
    input_json, result_json = _decode_data_param(encoded)
    assert input_json == "{}"
    assert result_json == "null"


def test_decode_data_param_malformed_returns_defaults():
    assert _decode_data_param("not-base64!") == ("{}", "null")
    assert _decode_data_param("") == ("{}", "null")


# ---------------------------------------------------------------------------
# _walk_directory
# ---------------------------------------------------------------------------


def test_walk_directory_nonexistent_returns_empty(tmp_path):
    assert _walk_directory(str(tmp_path / "nope")) == {}


def test_walk_directory_returns_relative_paths(tmp_path):
    (tmp_path / "a.txt").write_text("A")
    nested = tmp_path / "sub" / "deep"
    nested.mkdir(parents=True)
    (nested / "b.txt").write_text("B")

    result = _walk_directory(str(tmp_path))
    assert result["a.txt"] == "A"
    assert result[os.path.join("sub", "deep", "b.txt")] == "B"


def test_walk_directory_skips_unreadable(tmp_path):
    """Binary files that fail UTF-8 decode are silently skipped — the
    `except Exception: pass` swallow path."""
    (tmp_path / "ok.txt").write_text("hello")
    (tmp_path / "binary.dat").write_bytes(bytes([0xFF, 0xFE, 0x00, 0x80]))

    result = _walk_directory(str(tmp_path))
    assert result["ok.txt"] == "hello"
    assert "binary.dat" not in result


# ---------------------------------------------------------------------------
# _load_all / _save / _load / load_output
# ---------------------------------------------------------------------------


def test_save_load_round_trip(tmp_data_dirs):
    out = Output(name="round-trip", description="d", icon="x")
    _save(out)
    loaded = _load(out.id)
    assert loaded.name == "round-trip"
    assert loaded.description == "d"
    assert loaded.id == out.id


def test_load_missing_raises_404(tmp_data_dirs):
    with pytest.raises(HTTPException) as exc:
        _load("does-not-exist")
    assert exc.value.status_code == 404


def test_load_output_returns_none_for_missing(tmp_data_dirs):
    assert load_output("does-not-exist") is None


def test_load_output_returns_resolved(tmp_data_dirs):
    out = Output(name="x")
    _save(out)
    fetched = load_output(out.id)
    assert fetched is not None
    assert fetched.name == "x"


def test_load_all_picks_up_saved(tmp_data_dirs):
    a = Output(name="a")
    b = Output(name="b")
    _save(a)
    _save(b)
    names = sorted(o.name for o in _load_all())
    assert names == ["a", "b"]


def test_load_all_empty_when_dir_missing(monkeypatch, tmp_path):
    """If DATA_DIR doesn't exist, _load_all returns []."""
    monkeypatch.setattr(outputs_mod, "DATA_DIR", str(tmp_path / "nope"))
    assert _load_all() == []


# ---------------------------------------------------------------------------
# Models — legacy field migration + properties
# ---------------------------------------------------------------------------


def test_output_migrates_frontend_and_backend_code():
    out = Output(
        name="legacy",
        frontend_code="<html>x</html>",
        backend_code="result = {}",
    )
    assert out.files == {
        "index.html": "<html>x</html>",
        "backend.py": "result = {}",
    }
    assert out.frontend_code == "<html>x</html>"
    assert out.backend_code == "result = {}"


def test_output_already_has_files_drops_legacy_fields():
    out = Output(
        name="ok",
        files={"index.html": "<p>kept</p>"},
        frontend_code="<should-be-dropped/>",
        backend_code="dropped",
    )
    assert out.files == {"index.html": "<p>kept</p>"}


def test_output_frontend_backend_properties_default_to_empty():
    out = Output(name="empty")
    assert out.frontend_code == ""
    assert out.backend_code is None


def test_output_create_migrates_legacy_fields():
    create = OutputCreate(
        name="x",
        frontend_code="<html/>",
        backend_code="result = {}",
    )
    assert create.files["index.html"] == "<html/>"
    assert create.files["backend.py"] == "result = {}"


def test_output_update_partial_excludes_none():
    upd = OutputUpdate(name="renamed")
    dumped = upd.model_dump(exclude_none=True)
    assert dumped == {"name": "renamed"}


def test_output_update_migrates_legacy_fields():
    upd = OutputUpdate(frontend_code="<a/>")
    dumped = upd.model_dump(exclude_none=True)
    assert dumped["files"] == {"index.html": "<a/>"}


def test_workspace_seed_migrates_schema_json_field():
    seed = WorkspaceSeedRequest(
        workspace_id="ws-1",
        frontend_code="<html/>",
        backend_code="result = {}",
        schema_json='{"type":"object"}',
    )
    assert seed.files is not None
    assert seed.files["index.html"] == "<html/>"
    assert seed.files["backend.py"] == "result = {}"
    assert seed.files["schema.json"] == '{"type":"object"}'


def test_workspace_seed_files_already_set_drops_legacy():
    seed = WorkspaceSeedRequest(
        workspace_id="ws-2",
        files={"index.html": "<kept/>"},
        frontend_code="<dropped/>",
    )
    assert seed.files == {"index.html": "<kept/>"}


def test_auto_run_config_defaults():
    cfg = AutoRunConfig()
    assert cfg.enabled is False
    assert cfg.mode == "agent"
    assert cfg.model == "sonnet"
    assert cfg.context_paths == []
    assert cfg.forced_tools == []


# ---------------------------------------------------------------------------
# executor.execute_backend_code
# ---------------------------------------------------------------------------


async def test_execute_backend_happy_path():
    code = "result['x'] = input_data['y'] + 1"
    res = await execute_backend_code(code, {"y": 41})
    assert isinstance(res, BackendExecResult)
    assert res.result == {"x": 42}
    assert res.stdout == ""


async def test_execute_backend_captures_stdout():
    code = "print('hello world'); result['ok'] = True"
    res = await execute_backend_code(code, {})
    assert res.result == {"ok": True}
    assert "hello world" in res.stdout


async def test_execute_backend_syntax_error_raises():
    """SyntaxError during compile bubbles up as RuntimeError with the
    nonzero exit code."""
    with pytest.raises(RuntimeError) as exc:
        await execute_backend_code("def : bad", {})
    assert "Backend code error" in str(exc.value)


async def test_execute_backend_runtime_error_raises():
    with pytest.raises(RuntimeError) as exc:
        await execute_backend_code("raise ValueError('boom')", {})
    msg = str(exc.value)
    assert "Backend code error" in msg
    assert "ValueError" in msg or "boom" in msg


async def test_execute_backend_timeout(monkeypatch):
    from backend.apps.outputs import executor as exec_mod

    monkeypatch.setattr(exec_mod, "TIMEOUT_SECONDS", 0.1)
    with pytest.raises(RuntimeError) as exc:
        await execute_backend_code("import time; time.sleep(5)", {})
    assert "timed out" in str(exc.value)


async def test_execute_backend_non_json_output():
    """Corrupt the stdout JSON by writing extra bytes BEFORE the
    postamble's json.dump runs. Subprocess exits 0 but stdout no
    longer parses → JSONDecodeError → RuntimeError 'did not produce
    valid JSON'."""
    code = (
        "_orig_stdout.write('not json prefix ')\n"
        "_orig_stdout.flush()\n"
    )
    with pytest.raises(RuntimeError) as exc:
        await execute_backend_code(code, {})
    assert "did not produce valid JSON" in str(exc.value)
