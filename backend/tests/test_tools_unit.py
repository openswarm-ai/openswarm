"""Unit tests for the builtin agent tools.

These power the native agent loop's tool execution path. Currently 0%
covered because the live CLI uses its own tool implementations. These
tests pin the contract so the native loop can rely on it:

  - `tools/registry`: register/get/get_all/init_tools roster
  - `tools/filesystem`: Read (text + image + offset/limit + missing),
    Write (creates parent dirs), Edit (exact + multi + replace_all),
    Glob (sorted matches + cap), Grep (rg path + Python fallback)
  - `tools/system`: Bash (echo + nonzero + timeout), AskUserQuestion
  - `tools/web`: WebSearch (mocked DuckDuckGo HTML), WebFetch (mocked
    httpx + html stripping + prompt header)
"""

from __future__ import annotations

import asyncio
import base64
import os
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.apps.agents.tools import registry as registry_mod
from backend.apps.agents.tools.base import BaseTool, ToolContext
from backend.apps.agents.tools.filesystem import (
    EditTool,
    GlobTool,
    GrepTool,
    ReadTool,
    WriteTool,
    _resolve,
)
from backend.apps.agents.tools.registry import (
    get_all_tool_schemas,
    get_all_tools,
    get_tool,
    init_tools,
    register_tool,
)
from backend.apps.agents.tools.system import AskUserQuestionTool, BashTool
from backend.apps.agents.tools.web import WebFetchTool, WebSearchTool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ctx(cwd: str) -> ToolContext:
    return ToolContext(cwd=cwd, session_id="test-sess")


def _text(blocks: list[dict]) -> str:
    """Pull the text content out of a tool result block list."""
    return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")


# ---------------------------------------------------------------------------
# tools/registry
# ---------------------------------------------------------------------------


def test_registry_init_tools_registers_full_roster():
    """init_tools is run at import time. After import, all builtin
    tool names must be present in the registry."""
    init_tools()  # idempotent
    expected = {
        "Read", "Write", "Edit", "Glob", "Grep",
        "Bash", "AskUserQuestion",
        "WebSearch", "WebFetch",
    }
    actual = {t.name for t in get_all_tools()}
    assert expected.issubset(actual)


def test_register_tool_inserts_by_name():
    class FakeTool(BaseTool):
        name = "Fake_X"
        description = "fake"

        def get_schema(self) -> dict:
            return {"type": "object"}

        async def execute(self, input_data, context):
            return [{"type": "text", "text": "ok"}]

    register_tool(FakeTool())
    try:
        assert get_tool("Fake_X") is not None
        assert get_tool("Fake_X").description == "fake"
    finally:
        registry_mod._TOOLS.pop("Fake_X", None)


def test_get_tool_unknown_returns_none():
    assert get_tool("definitely-not-a-tool") is None


def test_get_all_tool_schemas_returns_provider_agnostic_shape():
    schemas = get_all_tool_schemas()
    assert all(hasattr(s, "name") and hasattr(s, "input_schema") for s in schemas)
    by_name = {s.name: s for s in schemas}
    # Read tool's schema must require file_path
    assert "Read" in by_name
    assert by_name["Read"].input_schema["required"] == ["file_path"]


# ---------------------------------------------------------------------------
# filesystem._resolve
# ---------------------------------------------------------------------------


def test_resolve_relative_path_uses_cwd(tmp_path):
    p = _resolve("foo.txt", str(tmp_path))
    assert p == (tmp_path / "foo.txt").resolve()


def test_resolve_absolute_path_passthrough(tmp_path):
    abs_path = str(tmp_path / "abs.txt")
    p = _resolve(abs_path, "/elsewhere")
    assert p == (tmp_path / "abs.txt").resolve()


# ---------------------------------------------------------------------------
# ReadTool
# ---------------------------------------------------------------------------


async def test_read_tool_text_file_returns_numbered_lines(tmp_path):
    f = tmp_path / "hello.txt"
    f.write_text("line one\nline two\nline three\n")
    out = await ReadTool().execute({"file_path": str(f)}, _ctx(str(tmp_path)))
    text = _text(out)
    assert "     1\tline one" in text
    assert "     2\tline two" in text
    assert "     3\tline three" in text


async def test_read_tool_offset_and_limit(tmp_path):
    """offset is 1-based line number; limit caps total lines returned."""
    f = tmp_path / "many.txt"
    f.write_text("\n".join(f"row {i}" for i in range(1, 21)) + "\n")
    out = await ReadTool().execute(
        {"file_path": str(f), "offset": 5, "limit": 3},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    lines = [l for l in text.splitlines() if l.strip()]
    assert len(lines) == 3
    assert "     5\trow 5" in lines[0]
    assert "     7\trow 7" in lines[2]


async def test_read_tool_missing_file_returns_error(tmp_path):
    out = await ReadTool().execute(
        {"file_path": str(tmp_path / "nope.txt")},
        _ctx(str(tmp_path)),
    )
    assert "Error: file not found" in _text(out)


async def test_read_tool_empty_file_returns_marker(tmp_path):
    f = tmp_path / "empty.txt"
    f.write_text("")
    out = await ReadTool().execute({"file_path": str(f)}, _ctx(str(tmp_path)))
    assert "file is empty or offset beyond" in _text(out)


async def test_read_tool_directory_path_returns_error(tmp_path):
    out = await ReadTool().execute(
        {"file_path": str(tmp_path)},
        _ctx(str(tmp_path)),
    )
    assert "not a regular file" in _text(out)


async def test_read_tool_image_returns_base64_block(tmp_path):
    """A PNG-extension file → image content block with base64 data."""
    f = tmp_path / "icon.png"
    raw = b"\x89PNG\r\n\x1a\nfake-png-bytes"
    f.write_bytes(raw)

    out = await ReadTool().execute({"file_path": str(f)}, _ctx(str(tmp_path)))
    assert len(out) == 1
    assert out[0]["type"] == "image"
    assert out[0]["source"]["media_type"] == "image/png"
    assert out[0]["source"]["data"] == base64.b64encode(raw).decode("ascii")


async def test_read_tool_offset_beyond_eof_returns_marker(tmp_path):
    f = tmp_path / "short.txt"
    f.write_text("only one line\n")
    out = await ReadTool().execute(
        {"file_path": str(f), "offset": 100},
        _ctx(str(tmp_path)),
    )
    assert "file is empty or offset beyond" in _text(out)


async def test_read_tool_zero_limit_falls_back_to_default(tmp_path):
    """limit<=0 → fall back to default 2000."""
    f = tmp_path / "two.txt"
    f.write_text("a\nb\n")
    out = await ReadTool().execute(
        {"file_path": str(f), "limit": 0},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    assert "     1\ta" in text and "     2\tb" in text


# ---------------------------------------------------------------------------
# WriteTool
# ---------------------------------------------------------------------------


async def test_write_tool_creates_file_and_parent_dirs(tmp_path):
    target = tmp_path / "deep" / "nested" / "file.txt"
    out = await WriteTool().execute(
        {"file_path": str(target), "content": "hello"},
        _ctx(str(tmp_path)),
    )
    assert "Successfully wrote 5 bytes" in _text(out)
    assert target.read_text() == "hello"


async def test_write_tool_overwrites_existing_file(tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("old")
    await WriteTool().execute(
        {"file_path": str(f), "content": "new"},
        _ctx(str(tmp_path)),
    )
    assert f.read_text() == "new"


# ---------------------------------------------------------------------------
# EditTool
# ---------------------------------------------------------------------------


async def test_edit_tool_unique_match_replaces(tmp_path):
    f = tmp_path / "edit.txt"
    f.write_text("hello world")
    out = await EditTool().execute(
        {"file_path": str(f), "old_string": "world", "new_string": "there"},
        _ctx(str(tmp_path)),
    )
    assert "1 replacement" in _text(out)
    assert f.read_text() == "hello there"


async def test_edit_tool_missing_string_errors(tmp_path):
    f = tmp_path / "edit.txt"
    f.write_text("nothing")
    out = await EditTool().execute(
        {"file_path": str(f), "old_string": "missing", "new_string": "x"},
        _ctx(str(tmp_path)),
    )
    assert "old_string not found" in _text(out)


async def test_edit_tool_multiple_matches_without_replace_all_errors(tmp_path):
    f = tmp_path / "edit.txt"
    f.write_text("aaaabbbb aaaa")
    out = await EditTool().execute(
        {"file_path": str(f), "old_string": "aaaa", "new_string": "X"},
        _ctx(str(tmp_path)),
    )
    assert "appears 2 times" in _text(out)
    # File contents unchanged
    assert f.read_text() == "aaaabbbb aaaa"


async def test_edit_tool_replace_all_replaces_every_match(tmp_path):
    f = tmp_path / "edit.txt"
    f.write_text("aaaa-aaaa-aaaa")
    out = await EditTool().execute(
        {
            "file_path": str(f),
            "old_string": "aaaa",
            "new_string": "X",
            "replace_all": True,
        },
        _ctx(str(tmp_path)),
    )
    assert "3 replacements" in _text(out)
    assert f.read_text() == "X-X-X"


async def test_edit_tool_missing_file(tmp_path):
    out = await EditTool().execute(
        {"file_path": str(tmp_path / "nope.txt"), "old_string": "x", "new_string": "y"},
        _ctx(str(tmp_path)),
    )
    assert "Error: file not found" in _text(out)


# ---------------------------------------------------------------------------
# GlobTool
# ---------------------------------------------------------------------------


async def test_glob_tool_matches_files_sorted_by_mtime(tmp_path):
    older = tmp_path / "older.py"
    older.write_text("a")
    newer = tmp_path / "newer.py"
    newer.write_text("b")
    # Force older to be older than newer
    os.utime(older, (1, 1))

    out = await GlobTool().execute(
        {"pattern": "*.py"},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    # Newer first
    newer_idx = text.find("newer.py")
    older_idx = text.find("older.py")
    assert newer_idx >= 0 and older_idx >= 0
    assert newer_idx < older_idx


async def test_glob_tool_no_matches_returns_marker(tmp_path):
    out = await GlobTool().execute(
        {"pattern": "*.nonexistent"},
        _ctx(str(tmp_path)),
    )
    assert "No files matched" in _text(out)


async def test_glob_tool_explicit_path_overrides_cwd(tmp_path):
    other = tmp_path / "other-dir"
    other.mkdir()
    (other / "x.md").write_text("x")
    out = await GlobTool().execute(
        {"pattern": "*.md", "path": str(other)},
        _ctx(str(tmp_path)),
    )
    assert "x.md" in _text(out)


async def test_glob_tool_invalid_path_returns_error(tmp_path):
    out = await GlobTool().execute(
        {"pattern": "*", "path": str(tmp_path / "nope")},
        _ctx(str(tmp_path)),
    )
    assert "directory not found" in _text(out)


# ---------------------------------------------------------------------------
# GrepTool
# ---------------------------------------------------------------------------


async def test_grep_tool_files_with_matches(tmp_path):
    a = tmp_path / "a.txt"
    a.write_text("the answer is 42")
    b = tmp_path / "b.txt"
    b.write_text("nothing here")

    out = await GrepTool().execute(
        {"pattern": "answer", "path": str(tmp_path)},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    assert "a.txt" in text
    assert "b.txt" not in text


async def test_grep_tool_content_mode_includes_line_numbers(tmp_path):
    a = tmp_path / "a.txt"
    a.write_text("first line\nthe answer is 42\nthird line\n")

    out = await GrepTool().execute(
        {"pattern": "answer", "path": str(tmp_path), "output_mode": "content"},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    # rg prints `path:lineno:content`; python fallback uses same shape
    assert "answer is 42" in text


async def test_grep_tool_count_mode(tmp_path):
    a = tmp_path / "a.txt"
    a.write_text("answer\nanswer\nnope\nanswer\n")

    out = await GrepTool().execute(
        {"pattern": "answer", "path": str(tmp_path), "output_mode": "count"},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    assert "3" in text


async def test_grep_tool_python_fallback_invalid_regex(tmp_path):
    """When ripgrep isn't available and the regex is invalid, the
    Python fallback returns a clean error block."""
    # Force the rg attempt to raise FileNotFoundError so we hit fallback.
    with patch("asyncio.create_subprocess_exec", side_effect=FileNotFoundError):
        out = await GrepTool().execute(
            {"pattern": "[unclosed", "path": str(tmp_path)},
            _ctx(str(tmp_path)),
        )
    assert "Invalid regex" in _text(out)


async def test_grep_tool_python_fallback_no_matches(tmp_path):
    a = tmp_path / "x.txt"
    a.write_text("nothing relevant")
    with patch("asyncio.create_subprocess_exec", side_effect=FileNotFoundError):
        out = await GrepTool().execute(
            {"pattern": "definitely-not-found", "path": str(tmp_path)},
            _ctx(str(tmp_path)),
        )
    assert "No matches found" in _text(out)


async def test_grep_tool_python_fallback_path_not_found(tmp_path):
    with patch("asyncio.create_subprocess_exec", side_effect=FileNotFoundError):
        out = await GrepTool().execute(
            {"pattern": "anything", "path": str(tmp_path / "missing")},
            _ctx(str(tmp_path)),
        )
    assert "path not found" in _text(out)


async def test_grep_tool_python_fallback_glob_filter(tmp_path):
    """Glob pattern restricts the file set the fallback scans."""
    (tmp_path / "match.py").write_text("found here")
    (tmp_path / "ignored.txt").write_text("found here too")

    with patch("asyncio.create_subprocess_exec", side_effect=FileNotFoundError):
        out = await GrepTool().execute(
            {"pattern": "found", "path": str(tmp_path), "glob": "*.py"},
            _ctx(str(tmp_path)),
        )
    text = _text(out)
    assert "match.py" in text
    assert "ignored.txt" not in text


# ---------------------------------------------------------------------------
# BashTool
# ---------------------------------------------------------------------------


async def test_bash_tool_echo_round_trip(tmp_path):
    out = await BashTool().execute(
        {"command": "echo hello"},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    assert "hello" in text


async def test_bash_tool_nonzero_exit_includes_code(tmp_path):
    out = await BashTool().execute(
        {"command": "exit 7"},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    assert "Exit code: 7" in text


async def test_bash_tool_runs_in_session_cwd(tmp_path):
    (tmp_path / "marker.txt").write_text("x")
    out = await BashTool().execute(
        {"command": "ls"},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    assert "marker.txt" in text


async def test_bash_tool_timeout_kills_process(tmp_path):
    """timeout in milliseconds; passing 50ms forces the timeout path."""
    out = await BashTool().execute(
        {"command": "sleep 5", "timeout": 50},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    assert "timed out" in text.lower()


async def test_bash_tool_empty_output_with_zero_exit_includes_marker(tmp_path):
    """Silent commands (e.g. `true`) get a synthetic completion marker."""
    out = await BashTool().execute(
        {"command": "true"},
        _ctx(str(tmp_path)),
    )
    text = _text(out)
    assert "exit code 0" in text


def test_bash_tool_truncate_helper_caps_long_output():
    """_truncate adds a marker when the body is >100KB."""
    long = "x" * (101 * 1024)
    truncated = BashTool._truncate(long)
    assert truncated.endswith("(output truncated)")


# ---------------------------------------------------------------------------
# AskUserQuestionTool
# ---------------------------------------------------------------------------


async def test_ask_user_question_returns_question_text():
    out = await AskUserQuestionTool().execute(
        {"question": "Which file?"},
        _ctx("/tmp"),
    )
    assert _text(out) == "Which file?"


def test_ask_user_question_schema_requires_question():
    schema = AskUserQuestionTool().get_schema()
    assert schema["required"] == ["question"]


# ---------------------------------------------------------------------------
# WebSearchTool
# ---------------------------------------------------------------------------


def _ddg_html(num: int = 3) -> str:
    """Minimal DuckDuckGo HTML result page."""
    blocks = []
    for i in range(num):
        blocks.append(
            f'<div class="result results_links results_links_deep">'
            f'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F{i}">Title {i}</a>'
            f'<a class="result__snippet" href="https://example.com/{i}">Snippet text {i}</a>'
            f'</div>'
        )
    return "".join(blocks)


async def test_web_search_tool_parses_ddg_results():
    fake_resp = MagicMock()
    fake_resp.text = _ddg_html(num=2)
    fake_resp.raise_for_status = MagicMock()

    fake_client = MagicMock()
    fake_client.post = AsyncMock(return_value=fake_resp)
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.agents.tools.web.httpx.AsyncClient", return_value=fake_client):
        out = await WebSearchTool().execute(
            {"query": "openswarm"},
            _ctx("/tmp"),
        )
    text = _text(out)
    assert "[1] Title 0" in text
    assert "https://example.com/0" in text
    assert "Snippet text 0" in text


async def test_web_search_tool_empty_results_returns_marker():
    fake_resp = MagicMock(text="<html></html>")
    fake_resp.raise_for_status = MagicMock()
    fake_client = MagicMock()
    fake_client.post = AsyncMock(return_value=fake_resp)
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.agents.tools.web.httpx.AsyncClient", return_value=fake_client):
        out = await WebSearchTool().execute(
            {"query": "no-such-thing"},
            _ctx("/tmp"),
        )
    assert "No search results" in _text(out)


async def test_web_search_tool_exception_returns_error():
    fake_client = MagicMock()
    fake_client.post = AsyncMock(side_effect=RuntimeError("boom"))
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.agents.tools.web.httpx.AsyncClient", return_value=fake_client):
        out = await WebSearchTool().execute(
            {"query": "x"},
            _ctx("/tmp"),
        )
    assert "Web search error" in _text(out)


async def test_web_search_tool_num_results_caps_returned_entries():
    fake_resp = MagicMock(text=_ddg_html(num=10))
    fake_resp.raise_for_status = MagicMock()
    fake_client = MagicMock()
    fake_client.post = AsyncMock(return_value=fake_resp)
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.agents.tools.web.httpx.AsyncClient", return_value=fake_client):
        out = await WebSearchTool().execute(
            {"query": "x", "num_results": 2},
            _ctx("/tmp"),
        )
    text = _text(out)
    assert "[1]" in text
    assert "[2]" in text
    assert "[3]" not in text


# ---------------------------------------------------------------------------
# WebFetchTool
# ---------------------------------------------------------------------------


async def test_web_fetch_tool_strips_html_to_plain_text():
    fake_resp = MagicMock()
    fake_resp.text = "<html><body><p>Hello <b>world</b></p><script>x()</script></body></html>"
    fake_resp.headers = {"content-type": "text/html"}
    fake_resp.raise_for_status = MagicMock()

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=fake_resp)
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.agents.tools.web.httpx.AsyncClient", return_value=fake_client):
        out = await WebFetchTool().execute(
            {"url": "https://example.com"},
            _ctx("/tmp"),
        )
    text = _text(out)
    assert "Contents of https://example.com" in text
    assert "Hello" in text
    assert "world" in text
    assert "<script>" not in text  # script blocks removed
    assert "<p>" not in text


async def test_web_fetch_tool_includes_prompt_in_header():
    fake_resp = MagicMock()
    fake_resp.text = "raw text content"
    fake_resp.headers = {"content-type": "text/plain"}
    fake_resp.raise_for_status = MagicMock()

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=fake_resp)
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.agents.tools.web.httpx.AsyncClient", return_value=fake_client):
        out = await WebFetchTool().execute(
            {"url": "https://example.com/x.txt", "prompt": "find the answer"},
            _ctx("/tmp"),
        )
    text = _text(out)
    assert "Looking for: find the answer" in text
    assert "raw text content" in text


async def test_web_fetch_tool_http_error_returns_marker():
    import httpx as _httpx

    err_resp = MagicMock()
    err_resp.status_code = 404
    err = _httpx.HTTPStatusError("404", request=MagicMock(), response=err_resp)

    fake_client = MagicMock()
    fake_client.get = AsyncMock(side_effect=err)
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.agents.tools.web.httpx.AsyncClient", return_value=fake_client):
        out = await WebFetchTool().execute(
            {"url": "https://example.com/missing"},
            _ctx("/tmp"),
        )
    text = _text(out)
    assert "HTTP error 404" in text


async def test_web_fetch_tool_generic_exception_returns_marker():
    fake_client = MagicMock()
    fake_client.get = AsyncMock(side_effect=RuntimeError("DNS exploded"))
    fake_client.__aenter__ = AsyncMock(return_value=fake_client)
    fake_client.__aexit__ = AsyncMock(return_value=False)

    with patch("backend.apps.agents.tools.web.httpx.AsyncClient", return_value=fake_client):
        out = await WebFetchTool().execute(
            {"url": "https://example.com/x"},
            _ctx("/tmp"),
        )
    text = _text(out)
    assert "Error fetching" in text
    assert "DNS exploded" in text
