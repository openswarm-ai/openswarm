"""Direct handler tests for the stdio MCP meta-servers.

The CLI-side MCP servers are launched as standalone Python subprocesses
by the SDK. Subprocess startup is the SDK's job; here we just exercise
the per-tool handler functions in-process. Each server's `call_backend`
helper goes through `urllib.request.urlopen`, which we mock with a
thin shim returning canned JSON.

Coverage targets (all currently 0%):
  - `outputs_meta_server`: TOOLS shape, OutputList success + empty +
    error, OutputSearch missing query + matches, OutputActivate
    unknown / already_active / activated paths, format_outputs
  - `mcp_meta_server`: TOOLS shape, MCPList success + empty + error,
    MCPSearch missing query + matches, MCPActivate unknown /
    already_active / activated paths
  - `web_mcp_server`: WebSearch + WebFetch happy paths and error
    branches, schema validation
  - `invoke_agent_mcp_server`: TOOLS shape, missing args, success
    payload formatting (cost line + source_name)
  - `browser_mcp_server`: action_map dispatch, missing browser_id,
    screenshot too large, text fallback
  - `browser_agent_mcp_server`: format_result + format_batch_results,
    CreateBrowserAgent / BrowserAgent / BrowserAgents validation
"""

from __future__ import annotations

import io
import json
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

from backend.apps.agents import (
    browser_agent_mcp_server as ba_srv,
    browser_mcp_server as br_srv,
    invoke_agent_mcp_server as inv_srv,
    mcp_meta_server as mcp_srv,
    outputs_meta_server as out_srv,
    web_mcp_server as web_srv,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@contextmanager
def _mock_backend(module, payload: dict | list):
    """Patch the module's `urllib.request.urlopen` to return `payload`
    as JSON. Works for every mcp meta-server because they all use the
    same stdlib request/json round-trip."""
    fake_resp = MagicMock()
    fake_resp.read.return_value = json.dumps(payload).encode()
    fake_resp.__enter__ = MagicMock(return_value=fake_resp)
    fake_resp.__exit__ = MagicMock(return_value=False)
    with patch.object(module.urllib.request, "urlopen", return_value=fake_resp):
        yield


def _text(blocks: list[dict]) -> str:
    return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")


# ---------------------------------------------------------------------------
# outputs_meta_server
# ---------------------------------------------------------------------------


def test_outputs_meta_tools_shape():
    """Every TOOLS entry must have name + description + inputSchema."""
    names = {t["name"] for t in out_srv.TOOLS}
    assert names == {"OutputList", "OutputSearch", "OutputActivate"}
    for t in out_srv.TOOLS:
        assert "description" in t
        assert "inputSchema" in t
        schema = t["inputSchema"]
        assert schema["type"] == "object"


def test_outputs_format_outputs_renders_status_and_use_count():
    out = out_srv.format_outputs(
        [{
            "id": "abc",
            "name": "My View",
            "description": "Does X",
            "status": "active",
            "use_count": 7,
        }],
        heading="Active:",
    )
    assert out.startswith("Active:")
    assert "`abc`" in out and "**My View**" in out
    assert "[active]" in out
    assert "(used 7×)" in out
    assert "Does X" in out


def test_outputs_format_outputs_empty_returns_empty_string():
    assert out_srv.format_outputs([]) == ""


def test_outputs_handle_list_empty():
    with _mock_backend(out_srv, {"active": [], "available": []}):
        out = out_srv.handle_tool_call("OutputList", {})
    assert "No Outputs / Views are defined" in _text(out["content"])
    assert "isError" not in out


def test_outputs_handle_list_with_data():
    with _mock_backend(out_srv, {
        "active": [{"id": "a1", "name": "A", "description": "x", "status": "active"}],
        "available": [{"id": "b2", "name": "B", "description": "y", "status": "available"}],
    }):
        out = out_srv.handle_tool_call("OutputList", {})
    text = _text(out["content"])
    assert "Active" in text and "Available" in text
    assert "`a1`" in text and "`b2`" in text


def test_outputs_handle_list_backend_error():
    with _mock_backend(out_srv, {"error": "backend down"}):
        out = out_srv.handle_tool_call("OutputList", {})
    assert out.get("isError") is True
    assert "backend down" in _text(out["content"])


def test_outputs_handle_search_missing_query():
    out = out_srv.handle_tool_call("OutputSearch", {})
    assert out.get("isError") is True
    assert "query is required" in _text(out["content"])


def test_outputs_handle_search_no_matches():
    with _mock_backend(out_srv, {"matches": []}):
        out = out_srv.handle_tool_call("OutputSearch", {"query": "anything"})
    assert "No Outputs matched" in _text(out["content"])


def test_outputs_handle_search_with_matches_includes_next_step():
    with _mock_backend(out_srv, {"matches": [
        {"id": "v1", "name": "View1", "description": "x", "status": "available"},
    ]}):
        out = out_srv.handle_tool_call("OutputSearch", {"query": "view"})
    text = _text(out["content"])
    assert "`v1`" in text
    assert "OutputActivate" in text


def test_outputs_handle_activate_missing_id():
    out = out_srv.handle_tool_call("OutputActivate", {})
    assert out.get("isError") is True
    assert "output_id is required" in _text(out["content"])


def test_outputs_handle_activate_unknown():
    with _mock_backend(out_srv, {
        "status": "unknown_output",
        "available": ["v1", "v2"],
    }):
        out = out_srv.handle_tool_call("OutputActivate", {"output_id": "phantom"})
    assert out.get("isError") is True
    text = _text(out["content"])
    assert "Unknown Output id" in text
    assert "`v1`" in text and "`v2`" in text


def test_outputs_handle_activate_already_active():
    with _mock_backend(out_srv, {"status": "already_active"}):
        out = out_srv.handle_tool_call("OutputActivate", {"output_id": "v1"})
    assert "isError" not in out
    assert "already active" in _text(out["content"])


def test_outputs_handle_activate_activated():
    with _mock_backend(out_srv, {"status": "activated"}):
        out = out_srv.handle_tool_call("OutputActivate", {"output_id": "v1"})
    assert "isError" not in out
    assert "Activated Output `v1`" in _text(out["content"])


def test_outputs_handle_activate_unexpected_status():
    with _mock_backend(out_srv, {"status": "wat"}):
        out = out_srv.handle_tool_call("OutputActivate", {"output_id": "v1"})
    assert out.get("isError") is True
    assert "Unexpected response" in _text(out["content"])


def test_outputs_handle_unknown_tool():
    out = out_srv.handle_tool_call("NotARealTool", {})
    assert out.get("isError") is True
    assert "Unknown tool" in _text(out["content"])


# ---------------------------------------------------------------------------
# mcp_meta_server
# ---------------------------------------------------------------------------


def test_mcp_meta_tools_shape():
    names = {t["name"] for t in mcp_srv.TOOLS}
    assert names == {"MCPList", "MCPSearch", "MCPActivate"}
    for t in mcp_srv.TOOLS:
        assert "inputSchema" in t


def test_mcp_meta_format_servers_renders_status():
    out = mcp_srv.format_servers(
        [{"name": "slack", "description": "Slack tools", "status": "active"}],
        heading="Active:",
    )
    assert "Active:" in out
    assert "`slack`" in out and "[active]" in out


def test_mcp_meta_handle_list_empty():
    with _mock_backend(mcp_srv, {"active": [], "available": []}):
        out = mcp_srv.handle_tool_call("MCPList", {})
    assert "No MCP servers are installed" in _text(out["content"])


def test_mcp_meta_handle_list_with_data():
    with _mock_backend(mcp_srv, {
        "active": [{"name": "slack", "description": "x", "status": "active"}],
        "available": [{"name": "discord", "description": "y", "status": "available"}],
    }):
        out = mcp_srv.handle_tool_call("MCPList", {})
    text = _text(out["content"])
    assert "Active" in text and "Available" in text


def test_mcp_meta_handle_list_backend_error():
    with _mock_backend(mcp_srv, {"error": "boom"}):
        out = mcp_srv.handle_tool_call("MCPList", {})
    assert out.get("isError") is True


def test_mcp_meta_handle_search_missing_query():
    out = mcp_srv.handle_tool_call("MCPSearch", {})
    assert out.get("isError") is True


def test_mcp_meta_handle_search_no_matches():
    with _mock_backend(mcp_srv, {"matches": []}):
        out = mcp_srv.handle_tool_call("MCPSearch", {"query": "x"})
    assert "No MCP servers matched" in _text(out["content"])


def test_mcp_meta_handle_search_with_matches_includes_next_step():
    with _mock_backend(mcp_srv, {"matches": [
        {"name": "slack", "description": "S", "status": "available"},
    ]}):
        out = mcp_srv.handle_tool_call("MCPSearch", {"query": "channel"})
    text = _text(out["content"])
    assert "MCPActivate" in text


def test_mcp_meta_handle_activate_missing_name():
    out = mcp_srv.handle_tool_call("MCPActivate", {})
    assert out.get("isError") is True


def test_mcp_meta_handle_activate_unknown_returns_valid_options():
    with _mock_backend(mcp_srv, {
        "status": "unknown_server",
        "available": ["slack", "notion"],
    }):
        out = mcp_srv.handle_tool_call("MCPActivate", {"server_name": "phantom"})
    text = _text(out["content"])
    assert out.get("isError") is True
    assert "`slack`" in text and "`notion`" in text


def test_mcp_meta_handle_activate_already_active():
    with _mock_backend(mcp_srv, {"status": "already_active"}):
        out = mcp_srv.handle_tool_call("MCPActivate", {"server_name": "slack"})
    assert "isError" not in out
    assert "already active" in _text(out["content"])


def test_mcp_meta_handle_activate_activated():
    with _mock_backend(mcp_srv, {"status": "activated"}):
        out = mcp_srv.handle_tool_call("MCPActivate", {"server_name": "slack"})
    assert "isError" not in out
    text = _text(out["content"])
    assert "mcp__slack__" in text  # next-turn hint


def test_mcp_meta_handle_unknown_tool():
    out = mcp_srv.handle_tool_call("NotReal", {})
    assert out.get("isError") is True


# ---------------------------------------------------------------------------
# web_mcp_server
# ---------------------------------------------------------------------------


def test_web_mcp_tools_shape():
    names = {t["name"] for t in web_srv.TOOLS}
    assert names == {"WebSearch", "WebFetch"}


def test_web_mcp_websearch_missing_query():
    out = web_srv.handle_tool_call("WebSearch", {})
    assert out.get("isError") is True


def test_web_mcp_websearch_returns_results():
    with _mock_backend(web_srv, {"results": "[1] Title\n  https://example.com"}):
        out = web_srv.handle_tool_call("WebSearch", {"query": "openswarm"})
    text = _text(out["content"])
    assert "Title" in text


def test_web_mcp_websearch_empty_results_falls_back_to_marker():
    with _mock_backend(web_srv, {"results": ""}):
        out = web_srv.handle_tool_call("WebSearch", {"query": "missing"})
    assert "No results for: missing" in _text(out["content"])


def test_web_mcp_websearch_backend_error():
    with _mock_backend(web_srv, {"error": "ddg down"}):
        out = web_srv.handle_tool_call("WebSearch", {"query": "x"})
    assert out.get("isError") is True
    assert "Search failed" in _text(out["content"])


def test_web_mcp_websearch_clamps_num_results():
    """num_results > 10 is clamped down to 10."""
    captured: dict = {}

    def _fake_post(url, body, timeout=45.0):
        captured.update(body)
        return {"results": "ok"}

    with patch.object(web_srv, "_post", side_effect=_fake_post):
        web_srv.handle_tool_call("WebSearch", {"query": "x", "num_results": 50})
    assert captured["num_results"] == 10


def test_web_mcp_webfetch_missing_url():
    out = web_srv.handle_tool_call("WebFetch", {})
    assert out.get("isError") is True


def test_web_mcp_webfetch_invalid_scheme():
    out = web_srv.handle_tool_call("WebFetch", {"url": "ftp://example.com"})
    assert out.get("isError") is True
    assert "must start with http" in _text(out["content"])


def test_web_mcp_webfetch_returns_content():
    with _mock_backend(web_srv, {"content": "Plain text content"}):
        out = web_srv.handle_tool_call(
            "WebFetch",
            {"url": "https://example.com", "prompt": "x"},
        )
    assert "Plain text content" in _text(out["content"])


def test_web_mcp_webfetch_empty_content_falls_back_to_marker():
    with _mock_backend(web_srv, {"content": ""}):
        out = web_srv.handle_tool_call("WebFetch", {"url": "https://example.com"})
    assert "No content returned from" in _text(out["content"])


def test_web_mcp_unknown_tool_returns_error():
    out = web_srv.handle_tool_call("Phantom", {})
    assert out.get("isError") is True


# ---------------------------------------------------------------------------
# invoke_agent_mcp_server
# ---------------------------------------------------------------------------


def test_invoke_agent_tools_shape():
    names = {t["name"] for t in inv_srv.TOOLS}
    assert names == {"InvokeAgent"}


def test_invoke_agent_unknown_tool():
    out = inv_srv.handle_tool_call("NotReal", {})
    assert out.get("isError") is True


def test_invoke_agent_missing_session_id():
    out = inv_srv.handle_tool_call("InvokeAgent", {"message": "hi"})
    assert out.get("isError") is True


def test_invoke_agent_missing_message():
    out = inv_srv.handle_tool_call("InvokeAgent", {"session_id": "x"})
    assert out.get("isError") is True


def test_invoke_agent_backend_error():
    with _mock_backend(inv_srv, {"error": "agent down"}):
        out = inv_srv.handle_tool_call("InvokeAgent", {
            "session_id": "x", "message": "hi",
        })
    assert out.get("isError") is True
    assert "agent down" in _text(out["content"])


def test_invoke_agent_success_format_includes_cost_and_source_name():
    with _mock_backend(inv_srv, {
        "forked_session_id": "fork-1",
        "response": "Did the thing",
        "cost_usd": 0.01,
        "source_name": "Original Agent",
    }):
        out = inv_srv.handle_tool_call("InvokeAgent", {
            "session_id": "x", "message": "hi",
        })
    text = _text(out["content"])
    assert "Original Agent" in text
    assert "fork-1" in text
    assert "$0.0100" in text
    assert "Did the thing" in text


def test_invoke_agent_zero_cost_omits_cost_line():
    with _mock_backend(inv_srv, {
        "forked_session_id": "fork-1",
        "response": "Result",
        "cost_usd": 0,
    }):
        out = inv_srv.handle_tool_call("InvokeAgent", {
            "session_id": "x", "message": "hi",
        })
    text = _text(out["content"])
    assert "Cost" not in text


# ---------------------------------------------------------------------------
# browser_mcp_server
# ---------------------------------------------------------------------------


def test_browser_mcp_handle_missing_browser_id():
    out = br_srv.handle_tool_call("BrowserScreenshot", {})
    assert out.get("isError") is True


def test_browser_mcp_unknown_tool():
    out = br_srv.handle_tool_call("Phantom", {"browser_id": "b1"})
    assert out.get("isError") is True


def test_browser_mcp_get_text_dispatches_action():
    captured: dict = {}

    def _fake_call(action, browser_id, params=None, tab_id=""):
        captured["action"] = action
        captured["browser_id"] = browser_id
        captured["params"] = params
        return {"text": "page contents here"}

    with patch.object(br_srv, "call_backend", side_effect=_fake_call):
        out = br_srv.handle_tool_call("BrowserGetText", {"browser_id": "b1"})

    assert captured["action"] == "get_text"
    assert captured["browser_id"] == "b1"
    text = _text(out["content"])
    assert "page contents here" in text


def test_browser_mcp_navigate_passes_url_in_params():
    captured: dict = {}

    def _fake_call(action, browser_id, params=None, tab_id=""):
        captured["params"] = params
        return {"text": "ok"}

    with patch.object(br_srv, "call_backend", side_effect=_fake_call):
        br_srv.handle_tool_call(
            "BrowserNavigate",
            {"browser_id": "b1", "url": "https://example.com"},
        )
    assert captured["params"] == {"url": "https://example.com"}


def test_browser_mcp_screenshot_returns_image_block():
    with patch.object(br_srv, "call_backend", return_value={
        "image": "AA==",
        "url": "https://example.com",
    }):
        out = br_srv.handle_tool_call(
            "BrowserScreenshot",
            {"browser_id": "b1"},
        )
    types = [b["type"] for b in out["content"]]
    assert "image" in types
    assert "text" in types


def test_browser_mcp_screenshot_too_large_returns_text_only():
    """Massive base64 with PIL unavailable → return text-only fallback."""
    huge = "x" * (br_srv.MAX_IMAGE_B64_BYTES + 1)
    with patch.object(br_srv, "call_backend", return_value={"image": huge, "url": "x"}), \
         patch.object(br_srv, "compress_screenshot", return_value=None):
        out = br_srv.handle_tool_call("BrowserScreenshot", {"browser_id": "b1"})
    assert all(b["type"] == "text" for b in out["content"])
    assert "too large" in _text(out["content"])


def test_browser_mcp_backend_error():
    with patch.object(br_srv, "call_backend", return_value={"error": "ws disconnected"}):
        out = br_srv.handle_tool_call("BrowserGetText", {"browser_id": "b1"})
    assert out.get("isError") is True
    assert "ws disconnected" in _text(out["content"])


# ---------------------------------------------------------------------------
# browser_agent_mcp_server
# ---------------------------------------------------------------------------


def test_browser_agent_tools_shape():
    names = {t["name"] for t in ba_srv.TOOLS}
    assert names == {"CreateBrowserAgent", "BrowserAgent", "BrowserAgents"}


def test_browser_agent_format_result_text_only():
    out = ba_srv.format_result({
        "summary": "Did the thing",
        "session_id": "s1",
        "browser_id": "b1",
        "action_log": [
            {"tool": "BrowserNavigate", "input": {"url": "https://example.com"}, "elapsed_ms": 50},
            {"tool": "BrowserClick", "input": {"selector": "#go"}, "elapsed_ms": 10},
        ],
    })
    text = _text(out["content"])
    assert "Browser Agent Result" in text
    assert "Did the thing" in text
    assert "BrowserNavigate" in text
    assert "BrowserClick" in text
    # No screenshot → no image content
    assert all(b["type"] == "text" for b in out["content"])


def test_browser_agent_format_result_error():
    out = ba_srv.format_result({"error": "no browser"})
    assert out.get("isError") is True
    assert "no browser" in _text(out["content"])


def test_browser_agent_format_batch_results_separates_with_divider():
    out = ba_srv.format_batch_results([
        {"summary": "A", "session_id": "s1", "browser_id": "b1", "action_log": []},
        {"summary": "B", "session_id": "s2", "browser_id": "b2", "action_log": []},
    ])
    text = _text(out["content"])
    assert "A" in text and "B" in text
    assert "---" in text


def test_browser_agent_format_batch_results_top_level_error():
    out = ba_srv.format_batch_results({"error": "all failed"})
    assert out.get("isError") is True


def test_browser_agent_create_calls_backend_and_formats_first_result():
    with patch.object(ba_srv, "call_backend", return_value={"results": [{
        "summary": "Done", "session_id": "s1", "browser_id": "b1", "action_log": [],
    }]}):
        out = ba_srv.handle_tool_call("CreateBrowserAgent", {"task": "fetch a page"})
    assert "Done" in _text(out["content"])


def test_browser_agent_browser_agent_missing_browser_id():
    out = ba_srv.handle_tool_call("BrowserAgent", {"task": "x"})
    assert out.get("isError") is True


def test_browser_agent_browser_agents_empty_tasks_errors():
    out = ba_srv.handle_tool_call("BrowserAgents", {"tasks": []})
    assert out.get("isError") is True


def test_browser_agent_browser_agents_missing_browser_id_in_task():
    out = ba_srv.handle_tool_call("BrowserAgents", {"tasks": [
        {"task": "x"},  # no browser_id
    ]})
    assert out.get("isError") is True


def test_browser_agent_browser_agents_success():
    with patch.object(ba_srv, "call_backend", return_value={"results": [
        {"summary": "A", "session_id": "s1", "browser_id": "b1", "action_log": []},
    ]}):
        out = ba_srv.handle_tool_call("BrowserAgents", {"tasks": [
            {"browser_id": "b1", "task": "x"},
        ]})
    assert "A" in _text(out["content"])


def test_browser_agent_unknown_tool():
    out = ba_srv.handle_tool_call("Phantom", {})
    assert out.get("isError") is True


def test_browser_agent_call_backend_http_error():
    """call_backend's exception branch surfaces the error string."""
    import urllib.error
    err = urllib.error.HTTPError(
        url="x", code=500, msg="boom", hdrs=None, fp=io.BytesIO(b"server err"),
    )
    with patch.object(ba_srv.urllib.request, "urlopen", side_effect=err):
        out = ba_srv.call_backend([{"task": "x", "browser_id": "b1", "url": ""}])
    assert "error" in out
    assert "HTTP 500" in out["error"]


def test_browser_agent_call_backend_generic_exception():
    with patch.object(ba_srv.urllib.request, "urlopen", side_effect=RuntimeError("dns")):
        out = ba_srv.call_backend([{"task": "x", "browser_id": "b1", "url": ""}])
    assert out == {"error": "dns"}
