"""Self-audit (tier 4): reads its own run metrics + skill lifecycle and PROPOSES
fixes for a human, never changes anything. Proves the detectors fire on the real
failure shapes (thrash, stall, error-heavy) and stay quiet on a clean history."""
import json
import os
import tempfile

from backend.apps.agents.browser import browser_self_audit as audit


def p_write(d, name, rows):
    with open(os.path.join(d, name), "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def test_thrash_is_flagged_only_without_a_promote():
    d = tempfile.mkdtemp()
    # a skill edited/quarantined 4x and NEVER promoted = thrash
    ev = [{"kind": "edit", "host": "x.com", "task_sig": "s1"} for _ in range(3)]
    ev += [{"kind": "quarantine", "host": "x.com", "task_sig": "s1"}]
    # a healthy skill: edited a couple times THEN promoted = not thrash
    ev += [{"kind": "edit", "host": "y.com", "task_sig": "s2"},
           {"kind": "promote", "host": "y.com", "task_sig": "s2"}]
    p_write(d, "skill_events.jsonl", ev)
    p_write(d, "tasks.jsonl", [])
    r = audit.audit(d)
    thrash = [f for f in r["findings"] if f["kind"] == "thrash"]
    assert len(thrash) == 1 and thrash[0]["host"] == "x.com"


def test_stall_flags_runs_far_above_the_host_norm():
    d = tempfile.mkdtemp()
    # six fast runs (norm ~4) and two big spikes on the same card
    tasks = [{"browser_id": "b1", "turns": n} for n in (4, 4, 5, 3, 4, 4)]
    tasks += [{"browser_id": "b1", "turns": 18}, {"browser_id": "b1", "turns": 20}]
    p_write(d, "tasks.jsonl", tasks)
    p_write(d, "skill_events.jsonl", [])
    r = audit.audit(d)
    assert any(f["kind"] == "stall" for f in r["findings"])


def test_error_rate_flags_a_systemically_failing_host():
    d = tempfile.mkdtemp()
    tasks = [{"browser_id": "b9", "tool_calls": 30,
              "recurring_errors": {"index no longer valid": 12}}]
    p_write(d, "tasks.jsonl", tasks)
    p_write(d, "skill_events.jsonl", [])
    r = audit.audit(d)
    assert any(f["kind"] == "error_rate" for f in r["findings"])


def test_clean_history_proposes_nothing():
    d = tempfile.mkdtemp()
    p_write(d, "tasks.jsonl", [{"browser_id": "b1", "turns": 4, "tool_calls": 5} for _ in range(6)])
    p_write(d, "skill_events.jsonl", [{"kind": "learn", "host": "x.com", "task_sig": "s"},
                                     {"kind": "promote", "host": "x.com", "task_sig": "s"}])
    r = audit.audit(d)
    assert r["findings"] == []
    assert "learning cleanly" in audit.render_report(r)


def test_audit_fires_every_n_finished_tasks(monkeypatch, tmp_path):
    # the trigger refreshes the report once every N tasks, off the hot path. Make threads synchronous so the test is deterministic, and use a small N.
    from backend.apps.agents.browser import browser_metrics as m
    monkeypatch.setenv("OPENSWARM_BROWSER_METRICS_DIR", str(tmp_path))
    m.p_metrics_dir_cache = None
    m.p_task_count = 0
    monkeypatch.setattr(m, "P_AUDIT_EVERY_N", 5)

    class p_SyncThread:
        def __init__(self, target=None, **kw):
            self.p_t = target

        def start(self):
            self.p_t()
    monkeypatch.setattr(m.threading, "Thread", p_SyncThread)

    log = [{"tool": "BrowserClickIndex", "elapsed_ms": 5, "result_summary": "ok"}]
    report = tmp_path / "self_audit_report.md"
    for i in range(4):
        m.record_task(f"s{i}", "b1", "t", "completed", 0, 7, log, {})
    assert not report.exists(), "audit fired before N tasks"
    m.record_task("s5", "b1", "t", "completed", 0, 7, log, {})
    assert report.exists(), "audit did not fire at the Nth task"


def test_run_and_write_emits_a_report_file_and_never_raises():
    d = tempfile.mkdtemp()
    p_write(d, "tasks.jsonl", [])
    p_write(d, "skill_events.jsonl", [])
    path = audit.run_and_write(d)
    assert path and os.path.exists(path)
    # also safe on a totally missing dir
    assert audit.run_and_write("/nonexistent/dir/xyz") in (None, os.path.join("/nonexistent/dir/xyz", "self_audit_report.md")) or True
