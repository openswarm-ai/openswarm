"""The router's pruner may never disable itself in silence (CLAUDE.md, row 6)."""
import logging
import re
from backend.apps.nine_router import history_prune_state as hps


def p_log(tmp_path, text: str) -> str:
    p = tmp_path / "start.log"
    p.write_bytes(text.encode())
    return str(p)


def p_capture(monkeypatch):
    records: list = []
    handler = logging.Handler()
    handler.emit = records.append
    hps.logger.addHandler(handler)
    hps.logger.setLevel(logging.DEBUG)
    monkeypatch.setattr(hps, "logger", hps.logger)
    return records, handler


def test_reads_all_three_verdicts(tmp_path) -> None:
    assert hps.history_prune_state(p_log(tmp_path, "boot\n[history-prune] installed\n")) == "installed"
    assert hps.history_prune_state(p_log(tmp_path, "[history-prune] FAILED to load; requests pass through unpruned\n")) == "failed"
    assert hps.history_prune_state(p_log(tmp_path, "boot, nothing about pruning\n")) == "unknown"
    assert hps.history_prune_state(str(tmp_path / "missing.log")) == "unknown"


def test_a_failed_pruner_in_a_packaged_build_warns_and_names_what_stopped(tmp_path, monkeypatch) -> None:
    records, handler = p_capture(monkeypatch)
    try:
        state = hps.report_history_prune_state(p_log(tmp_path, "[history-prune] FAILED to load; requests pass through unpruned\n"), packaged=True)
    finally:
        hps.logger.removeHandler(handler)
    assert state == "failed"
    warns = [r for r in records if r.levelno >= logging.WARNING]
    assert warns, "the fallback must be LOUD"
    msg = warns[0].getMessage()
    assert "FULL tool history" in msg and "context wall" in msg


def test_silence_in_a_packaged_build_is_also_a_warning(tmp_path, monkeypatch) -> None:
    records, handler = p_capture(monkeypatch)
    try:
        state = hps.report_history_prune_state(p_log(tmp_path, "ready\n"), packaged=True)
    finally:
        hps.logger.removeHandler(handler)
    assert state == "unknown"
    assert [r for r in records if r.levelno >= logging.WARNING], "a patch that never announced itself did not load"


def test_installed_and_dev_silence_are_quiet(tmp_path, monkeypatch) -> None:
    records, handler = p_capture(monkeypatch)
    try:
        hps.report_history_prune_state(p_log(tmp_path, "[history-prune] installed\n"), packaged=True)
        hps.report_history_prune_state(p_log(tmp_path, "nothing\n"), packaged=False)
    finally:
        hps.logger.removeHandler(handler)
    assert not [r for r in records if r.levelno >= logging.WARNING], "dev captures no stderr, so silence there is not a verdict"


def test_the_report_is_wired_onto_the_start_success_path() -> None:
    src = open("backend/apps/nine_router/process.py").read()
    ok = src.index('logger.info("9Router started successfully")')
    call = src.index("report_history_prune_state(p_cap_path, p_is_packaged)")
    ret = src.index("return", call)
    assert ok < call < ret, "the verdict is read right after a successful start, before the function returns"


def test_the_patch_loads_the_pruner_eagerly_not_lazily() -> None:
    src = open("backend/apps/agents/9router_gpt5_patch.js").read()
    assert re.search(r"^loadHistoryPrune\(\);", src, re.M), "a lazy load only speaks on the first request; the boot log would stay empty"
    assert src.index("loadHistoryPrune();") < src.index("function historyPrune(")
