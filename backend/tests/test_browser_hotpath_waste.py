"""Hot-path waste removals in the browser sub-agent loop.

Two per-action costs that were pure waste:
  1. browser_metrics.metrics_dir() ran os.makedirs() on EVERY tool call.
  2. The loop-detection hash serialized a tool's full result (a ~1MB screenshot
     or 15KB read) even for tools that are excluded from loop detection, where
     detect_loop ignores the hash entirely. These pin both fixes.
"""

import os

import backend.apps.agents.browser.browser_metrics as M
from backend.apps.agents.browser.browser_loop import (
    detect_loop,
    LOOP_DETECTION_EXCLUDED_TOOLS,
)


def test_metrics_dir_is_cached_makedirs_runs_once(monkeypatch):
    M.p_metrics_dir_cache = None
    calls = {"n": 0}
    real = os.makedirs

    def counting(*a, **k):
        calls["n"] += 1
        return real(*a, **k)

    monkeypatch.setattr(os, "makedirs", counting)
    d1 = M.metrics_dir()
    d2 = M.metrics_dir()
    d3 = M.metrics_dir()
    assert d1 == d2 == d3
    assert calls["n"] == 1, f"makedirs must run once, ran {calls['n']}x"


def test_excluded_tools_never_register_a_loop():
    # The invariant the hash-skip relies on: for every excluded tool, even ten identical calls in a row are NOT a loop, so computing/storing the hash for them was dead work. Setting is_loop=False directly is therefore equivalent.
    for tool in LOOP_DETECTION_EXCLUDED_TOOLS:
        key = (tool, "in", "out")
        assert detect_loop([key] * 10, key) is False, f"{tool} wrongly looped"


def test_non_excluded_tool_still_loops_after_threshold():
    # Guard the other side: the fix must NOT disable loop detection for the tools that need it (clicks/types/etc.).
    key = ("BrowserClick", '{"selector":"#x"}', "clicked")
    # below threshold -> not a loop; at/over threshold within the window -> loop
    assert detect_loop([], key) is False        # 1st occurrence: not yet a wall
    assert detect_loop([key], key) is True       # 2nd identical (threshold=2): a wall
    assert detect_loop([key] * 5, key) is True
