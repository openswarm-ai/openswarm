"""Pins the transport ceiling contract (found 2026-08-19): a tools/call response line past the
CLI's silent drop threshold must be shrunk (image stripped, text elided) rather than written,
because an oversized line is WRITTEN successfully and then never resolves, hanging the call
until a watchdog shoots the healthy sidecar."""
import importlib.util
import json
import os

spec = importlib.util.spec_from_file_location(
    "combined_meta_mcp_server",
    os.path.join(os.path.dirname(__file__), "..", "apps", "agents", "combined_meta_mcp_server.py"),
)


def p_load():
    os.environ.setdefault("OSW_MCP_MODULES", "")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_small_response_untouched():
    mod = p_load()
    r = {"content": [{"type": "text", "text": "hello"}]}
    assert mod.p_shrink_oversize(r) == r


def test_oversize_image_block_stripped_with_note():
    mod = p_load()
    r = {"content": [
        {"type": "text", "text": "summary here"},
        {"type": "image", "data": "A" * 340_000, "mimeType": "image/png"},
    ]}
    out = mod.p_shrink_oversize(r)
    kinds = [c.get("type") for c in out["content"]]
    assert "image" not in kinds
    assert any("screenshot omitted" in str(c.get("text", "")) for c in out["content"])
    assert len(json.dumps({"result": out})) < mod.P_MAX_RESPONSE_BYTES


def test_oversize_text_elided():
    mod = p_load()
    r = {"content": [{"type": "text", "text": "B" * 400_000}]}
    out = mod.p_shrink_oversize(r)
    assert len(json.dumps({"result": out})) < mod.P_MAX_RESPONSE_BYTES
    assert "elided" in out["content"][0]["text"]


def test_error_results_keep_flag():
    mod = p_load()
    r = {"content": [{"type": "image", "data": "C" * 300_000, "mimeType": "image/png"}], "isError": True}
    out = mod.p_shrink_oversize(r)
    assert out.get("isError") is True
