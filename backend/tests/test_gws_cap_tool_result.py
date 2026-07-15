"""Google-workspace shim result cap invariant.

The bug class (1.5.4 field report, Alex's query_gmail_emails thrash): a single
oversized Gmail/Drive dump exceeds the CLI's ~25K-token MCP cap, gets spilled to
a file, the model re-reads it back, and the context refills into the CLI's
autocompact-thrash. The seal: the shim caps its own tool-result text under that
spill threshold, with a clear paginate marker, and fails open on any shape it
doesn't recognize so an upstream contract change never crashes the shim.
"""

from types import SimpleNamespace

from backend.apps.google_workspace_mcp_shim.cap_tool_result import (
    MAX_RESULT_CHARS,
    cap_tool_result,
)


def block(text: str) -> SimpleNamespace:
    return SimpleNamespace(type="text", text=text)


def test_small_result_untouched() -> None:
    b = block("one short email")
    cap_tool_result(([b], {"result": "one short email"}))
    assert b.text == "one short email"


def test_oversized_single_block_capped_with_marker_and_spilled(tmp_path, monkeypatch) -> None:
    import backend.apps.google_workspace_mcp_shim.cap_tool_result as capmod
    monkeypatch.setattr(capmod, "REPORT_DIR", str(tmp_path))
    b = block("E" * 300_000)
    cap_tool_result(([b], {"result": "E" * 300_000}))
    assert len(b.text) < MAX_RESULT_CHARS + 600
    assert b.text.startswith("E")
    assert "Truncated" in b.text
    assert "saved to" in b.text
    assert len(b.text) // 4 < 25_000
    reports = list(tmp_path.iterdir())
    assert len(reports) == 1
    assert reports[0].read_text() == "E" * 300_000


def test_budget_spans_multiple_blocks(tmp_path, monkeypatch) -> None:
    import backend.apps.google_workspace_mcp_shim.cap_tool_result as capmod
    monkeypatch.setattr(capmod, "REPORT_DIR", str(tmp_path))
    a, b, c = block("A" * 40_000), block("B" * 40_000), block("C" * 40_000)
    cap_tool_result([a, b, c])
    assert a.text == "A" * 40_000
    assert "Truncated" in b.text and b.text.startswith("B")
    assert c.text == ""


def test_non_text_blocks_pass_through() -> None:
    img = SimpleNamespace(type="image", data="zzz")
    txt = block("hello")
    cap_tool_result([img, txt])
    assert img.data == "zzz"
    assert txt.text == "hello"


def test_bare_list_return_shape(tmp_path, monkeypatch) -> None:
    import backend.apps.google_workspace_mcp_shim.cap_tool_result as capmod
    monkeypatch.setattr(capmod, "REPORT_DIR", str(tmp_path))
    b = block("Z" * 100_000)
    out = cap_tool_result([b])
    assert out is not None
    assert "Truncated" in b.text


def test_fail_open_on_unexpected_shapes() -> None:
    assert cap_tool_result(None) is None
    assert cap_tool_result({"structured": "only"}) == {"structured": "only"}
    assert cap_tool_result("raw string") == "raw string"
    junk = [SimpleNamespace(nope=1)]
    cap_tool_result(junk)  # no .type/.text -> untouched, no raise
    assert junk[0].nope == 1
