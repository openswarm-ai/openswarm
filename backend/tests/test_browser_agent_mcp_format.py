"""Browser-agent MCP result payload caps.

The bug: format_result forwarded the sub-agent's summary and full action log
uncapped. The bundled Claude CLI rejects any MCP tool result past ~25K tokens
(the model never sees the report at all), and repeated near-cap results were
the refill mass behind the CLI's "Autocompact is thrashing" turn-killer seen
on 1.5.4 installs.

The seal: summary is head+tail capped at MAX_SUMMARY_CHARS and the action log
keeps only the last MAX_ACTION_LOG_ENTRIES entries, so one delegation result
can never approach the CLI rejection threshold on the text side.
"""

from backend.apps.agents.browser_agent_mcp_server import (
    MAX_ACTION_LOG_ENTRIES,
    MAX_SUMMARY_CHARS,
    format_result,
)


def result_text(result: dict) -> str:
    blocks = [b for b in result["content"] if b.get("type") == "text"]
    return "\n".join(b["text"] for b in blocks)


def test_small_summary_passes_through_unchanged() -> None:
    text = result_text(format_result({"summary": "all done"}))
    assert "**Summary:** all done" in text
    assert "omitted" not in text


def test_giant_summary_keeps_head_and_tail_and_spills_full_report(tmp_path, monkeypatch) -> None:
    import backend.apps.agents.browser_agent_mcp_server as srv
    monkeypatch.setattr(srv, "REPORT_DIR", str(tmp_path))
    summary = "HEADSTART " + ("x" * 60_000) + " TAILEND"
    text = result_text(format_result({"summary": summary}))
    assert len(text) < MAX_SUMMARY_CHARS + 500
    assert "HEADSTART" in text
    assert "omitted" in text
    assert "Full unabridged report saved to:" in text
    reports = list(tmp_path.iterdir())
    assert len(reports) == 1
    assert summary in reports[0].read_text()


def test_action_log_keeps_last_entries_with_original_numbering(tmp_path, monkeypatch) -> None:
    import backend.apps.agents.browser_agent_mcp_server as srv
    monkeypatch.setattr(srv, "REPORT_DIR", str(tmp_path))
    log = [{"tool": f"Act{i}", "input": {}, "elapsed_ms": i} for i in range(100)]
    text = result_text(format_result({"summary": "ok", "action_log": log}))
    assert "(... 60 earlier actions omitted ...)" in text
    assert "61. Act60(" in text
    assert "100. Act99(" in text
    # The full log (including the 60 omitted entries) lands in the spilled report.
    reports = list(tmp_path.iterdir())
    assert len(reports) == 1
    assert "Act59" in reports[0].read_text()


def test_short_action_log_has_no_omission_line() -> None:
    log = [{"tool": "Click", "input": {"x": 1}, "elapsed_ms": 5}]
    text = result_text(format_result({"summary": "ok", "action_log": log}))
    assert "omitted" not in text
    assert "1. Click(" in text


def test_pathological_result_stays_far_under_cli_rejection_cap(tmp_path, monkeypatch) -> None:
    import backend.apps.agents.browser_agent_mcp_server as srv
    monkeypatch.setattr(srv, "REPORT_DIR", str(tmp_path))
    log = [{"tool": "T", "input": {"v": "y" * 500}, "elapsed_ms": 1} for i in range(500)]
    out = format_result({"summary": "z" * 200_000, "action_log": log})
    total = len(result_text(out))
    assert total < MAX_SUMMARY_CHARS + MAX_ACTION_LOG_ENTRIES * 160 + 800


def test_error_result_untouched() -> None:
    out = format_result({"error": "boom"})
    assert out["isError"] is True
    assert "boom" in result_text(out)
