"""Persisted browser metrics: tier mapping, event + task recording, rollups."""

import json
import os
import tempfile

import pytest


@pytest.fixture()
def metrics(monkeypatch):
    d = tempfile.mkdtemp(prefix="bm_test_")
    monkeypatch.setenv("OPENSWARM_BROWSER_METRICS_DIR", d)
    from backend.apps.agents.browser import browser_metrics as bm
    # The dir is memoized once for the prod hot path; drop the cache so each test re-resolves to its own temp dir instead of inheriting a prior test's.
    bm.p_metrics_dir_cache = None
    return bm, d


def p_read(d, name):
    p = os.path.join(d, name)
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return [json.loads(line) for line in f if line.strip()]


def test_tier_mapping(metrics):
    bm, _ = metrics
    assert bm.tier_for("BrowserListInteractives") == "t3_action_surface"
    assert bm.tier_for("BrowserClickIndex") == "t3_action_surface"
    assert bm.tier_for("BrowserScreenshot") == "t5_vision"
    assert bm.tier_for("BrowserReplayRoute") == "t2_route_replay"
    assert bm.tier_for("BrowserDetectWebMCP") == "t1_webmcp"
    assert bm.tier_for("BrowserGetText") == "t4_content"
    assert bm.tier_for("SomethingNew") == "other"


def test_record_tool_writes_event(metrics):
    bm, d = metrics
    bm.record_tool("s1", "b1", 2, "BrowserListInteractives", 18,
                   ok=True, error="", is_loop=False, stagnation_streak=0, result_len=120)
    events = p_read(d, "events.jsonl")
    assert len(events) == 1
    e = events[0]
    assert e["tool"] == "BrowserListInteractives" and e["tier"] == "t3_action_surface"
    assert e["elapsed_ms"] == 18 and e["ok"] is True and e["error"] == ""


def test_record_tool_captures_error(metrics):
    bm, d = metrics
    bm.record_tool("s1", "b1", 3, "BrowserClickIndex", 9,
                   ok=False, error="Index 4 is no longer valid", is_loop=True,
                   stagnation_streak=2, result_len=40)
    e = p_read(d, "events.jsonl")[0]
    assert e["ok"] is False and "no longer valid" in e["error"]
    assert e["is_loop"] is True and e["stagnation_streak"] == 2


def test_record_task_summary_and_rollups(metrics):
    bm, d = metrics
    action_log = [
        {"tool": "BrowserListInteractives", "elapsed_ms": 20, "result_summary": "5 interactive elements"},
        {"tool": "BrowserClickIndex", "elapsed_ms": 10, "result_summary": "Clicked index 1"},
        {"tool": "BrowserClickIndex", "elapsed_ms": 8, "result_summary": "Error: Index 2 not found"},
        {"tool": "BrowserScreenshot", "elapsed_ms": 40, "result_summary": "Screenshot captured"},
    ]
    summary = bm.record_task("s1", "b1", "do a thing", "completed", __import__("time").time() - 1.2,
                             6, action_log, {"input": 1500, "output": 300})
    assert summary["completed"] is True and summary["status"] == "completed"
    assert summary["tool_calls"] == 4 and summary["tokens_in"] == 1500
    t3 = summary["by_tier"]["t3_action_surface"]
    assert t3["calls"] == 3 and t3["errors"] == 1 and t3["avg_ms"] > 0
    assert summary["by_tier"]["t5_vision"]["calls"] == 1
    assert summary["total_ms"] >= 1000  # ~1.2s elapsed
    assert any("not found" in err[0].lower() for err in summary["recurring_errors"])
    tasks = p_read(d, "tasks.jsonl")
    assert len(tasks) == 1 and tasks[0]["status"] == "completed"


def test_metrics_never_raises_on_bad_dir(monkeypatch):
    # An unwritable dir must not throw into the agent loop.
    monkeypatch.setenv("OPENSWARM_BROWSER_METRICS_DIR", "/proc/cannot/write/here")
    from backend.apps.agents.browser import browser_metrics as bm
    bm.p_metrics_dir_cache = None  # re-resolve so we actually hit the bad dir
    bm.record_tool("s", "b", 1, "BrowserScreenshot", 5, ok=True, error="",
                   is_loop=False, stagnation_streak=0, result_len=1)  # must not raise
    bm.record_task("s", "b", "t", "error", __import__("time").time(), 1, [], {})


def test_task_secrets_are_scrubbed_from_tasks_jsonl(tmp_path, monkeypatch):
    from backend.apps.agents.browser import browser_metrics as bm
    import os as p_os
    import time as p_time
    monkeypatch.setenv("OPENSWARM_BROWSER_METRICS_DIR", str(tmp_path))
    bm.p_metrics_dir_cache = None
    bm.record_task("s1", "b1", "log into acme with password hunter2 then post sk-abc12345678901234567",
                   "completed", p_time.time() - 1, 2, [], {})
    line = open(p_os.path.join(str(tmp_path), "tasks.jsonl")).read()
    assert "hunter2" not in line and "sk-abc" not in line
    assert "password [redacted]" in line
    # owner-only file perms
    mode = p_os.stat(p_os.path.join(str(tmp_path), "tasks.jsonl")).st_mode & 0o777
    assert mode == 0o600
