"""Ghost-success detector (scripts/analyze-browser-metrics.py): a 'completed'
task with no verifiable work must be flagged, but honest reads/actions must not.
This is the guard against features that fail silently without erroring."""

import importlib.util
import os

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "analyze-browser-metrics.py")


def load():
    spec = importlib.util.spec_from_file_location("abm", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def ev(tool, ok=True, loop=False, result_len=50):
    return {"tool": tool, "ok": ok, "is_loop": loop, "result_len": result_len}


def test_zero_tools_is_ghost():
    gv = load().ghost_verdict
    is_ghost, reasons = gv({"status": "completed"}, [])
    assert is_ghost and any("ZERO" in r for r in reasons)


def test_read_with_content_is_not_ghost():
    # a pure read task that actually returned data is legitimate work
    gv = load().ghost_verdict
    is_ghost, _ = gv({"status": "completed"}, [ev("BrowserGetText", result_len=120)])
    assert not is_ghost


def test_empty_reads_only_is_ghost():
    gv = load().ghost_verdict
    is_ghost, reasons = gv({"status": "completed"}, [
        ev("BrowserGetText", result_len=0), ev("BrowserScreenshot", result_len=0)])
    assert is_ghost


def test_all_productive_actions_errored_is_ghost():
    gv = load().ghost_verdict
    is_ghost, _ = gv({"status": "completed"}, [
        ev("BrowserClickIndex", ok=False), ev("BrowserClickIndex", ok=False)])
    assert is_ghost


def test_honest_action_is_not_ghost():
    gv = load().ghost_verdict
    is_ghost, _ = gv({"status": "completed"}, [ev("BrowserNavigate"), ev("BrowserClickIndex")])
    assert not is_ghost


def test_loop_during_completed_is_ghost():
    gv = load().ghost_verdict
    is_ghost, reasons = gv({"status": "completed"}, [ev("BrowserNavigate"), ev("BrowserClickIndex", loop=True)])
    assert is_ghost and any("loop" in r.lower() for r in reasons)


def test_errored_task_is_never_ghost():
    # an honest failure (status=error) is not a ghost; ghosts are fake successes
    gv = load().ghost_verdict
    assert not gv({"status": "error"}, [])[0]


def test_tier_mapping_present():
    # the analyzer's _PRODUCTIVE set must include the real mutation tools
    m = load()
    for t in ("BrowserClick", "BrowserClickIndex", "BrowserType", "BrowserNavigate", "BrowserReplayRoute"):
        assert t in m._PRODUCTIVE
