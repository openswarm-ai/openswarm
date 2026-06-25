"""The skill layer's own honesty check.

Drives the REAL skill + metrics functions through full multi-run lifecycles and
then runs the REAL analyzer over the emitted JSONL, asserting it (a) measures the
replay speedup when the layer helps and (b) FLAGS the silent ghost when a task is
repeated but never reaches the fast path (thrash / won't-distill). If the analyzer
couldn't tell those apart, "it completed" would hide a feature that never helps.
"""

import importlib.util
import os
import time

from backend.apps.agents.browser import browser_skills as sk
from backend.apps.agents.browser import browser_metrics as bm

P_ANALYZER = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "analyze-browser-metrics.py")


def p_load_analyzer():
    spec = importlib.util.spec_from_file_location("bma", P_ANALYZER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def p_log():
    return [
        {"tool": "BrowserNavigate", "input": {"url": "http://h/form"}, "ok": True},
        {"tool": "BrowserType", "input": {"selector": "#q", "text": "shoes"}, "ok": True},
        {"tool": "BrowserClickIndex", "input": {}, "ok": True, "clicked_role": "button", "clicked_name": "Search"},
    ]


def p_task_row(sig, path, dur_s, turns=None, playbook_seeded=False):
    # started_at in the past makes record_task compute a realistic total_ms.
    bm.record_task("s-" + sig + path + str(turns) + str(playbook_seeded), "b", sig, "completed",
                   time.time() - dur_s, turns if turns is not None else (0 if path == "replay" else 3),
                   p_log(), {"input": 10, "output": 5}, path=path, task_sig=sig,
                   playbook_seeded=playbook_seeded)


def test_skill_events_are_emitted_for_each_transition(p_metrics_dir):
    sk.clear(wipe_disk=True)
    sk.record_skill("shop.com", "search now", p_log())            # learn
    sk.mark_replay_succeeded("shop.com", "search now")           # promote
    sk.mark_replay_failed("shop.com", "search now")              # kept (trusted, 1)
    sk.mark_replay_failed("shop.com", "search now")              # demote
    evs = p_read(os.path.join(p_metrics_dir, "skill_events.jsonl"))
    kinds = [e["kind"] for e in evs]
    assert "learn" in kinds and "promote" in kinds and "demote" in kinds
    # every event carries enough to group + reason about it
    assert all(e.get("host") and e.get("task_sig") and e.get("kind") for e in evs)


def test_analyzer_measures_replay_speedup_when_the_layer_helps(p_metrics_dir, capsys):
    sk.clear(wipe_disk=True)
    # A repeated task: 1 slow LLM run, then 2 fast replays -> measurable speedup.
    sk.record_skill("shop.com", "search now", p_log())
    p_task_row(sk.compute_sig("search now"), "llm", 4.0)
    sk.mark_replay_succeeded("shop.com", "search now")
    p_task_row(sk.compute_sig("search now"), "replay", 0.04)
    p_task_row(sk.compute_sig("search now"), "replay", 0.05)

    mod = p_load_analyzer()
    tasks = mod.load(os.path.join(p_metrics_dir, "tasks.jsonl"))
    sevs = mod.load(os.path.join(p_metrics_dir, "skill_events.jsonl"))
    mod.skill_layer_report(tasks, sevs)
    out = capsys.readouterr().out
    assert "REPLAY SPEEDUP" in out
    assert "x faster" in out and "replay" in out


def test_analyzer_flags_silent_non_help_thrash(p_metrics_dir, capsys):
    sk.clear(wipe_disk=True)
    # A task that keeps getting re-learned/edited and quarantined, never promoted, and whose runs always go via the LLM (never the fast path) = the ghost.
    sk.record_skill("bad.com", "do thing now", p_log())                  # learn
    sk.mark_replay_failed("bad.com", "do thing now")                    # quarantine
    edited = p_log()[:-1] + [{"tool": "BrowserClickIndex", "input": {}, "ok": True,
                             "clicked_role": "button", "clicked_name": "Other"}]
    sk.record_skill("bad.com", "do thing now", edited)                  # edit (un-quarantine)
    sk.mark_replay_failed("bad.com", "do thing now")                    # quarantine again
    p_task_row(sk.compute_sig("do thing now"), "llm", 3.0)
    p_task_row(sk.compute_sig("do thing now"), "llm_fallback", 3.2)

    mod = p_load_analyzer()
    tasks = mod.load(os.path.join(p_metrics_dir, "tasks.jsonl"))
    sevs = mod.load(os.path.join(p_metrics_dir, "skill_events.jsonl"))
    mod.skill_layer_report(tasks, sevs)
    out = capsys.readouterr().out
    assert "SILENT NON-HELP" in out          # repeated but never replayed
    assert "THRASH" in out                   # re-learned/edited, never promoted


def test_analyzer_reports_composition(p_metrics_dir, capsys):
    sk.clear(wipe_disk=True)
    sk.record_skill("shop.com", "search now", p_log())
    sk.mark_replay_succeeded("shop.com", "search now")            # trusted foundation
    plus = p_log() + [{"tool": "BrowserClickIndex", "input": {}, "ok": True,
                      "clicked_role": "button", "clicked_name": "Checkout"}]
    sk.record_skill("shop.com", "search and checkout now", plus)  # composes on foundation
    sk.mark_replay_succeeded("shop.com", "search and checkout now")  # dependent earns trust too
    sk.deprecate_skill("shop.com", "search now")                 # must invalidate the TRUSTED dependent

    mod = p_load_analyzer()
    sevs = mod.load(os.path.join(p_metrics_dir, "skill_events.jsonl"))
    # the invalidate EVENT must actually fire (end-to-end), not just the state flip
    assert any(e["kind"] == "invalidate" for e in sevs)
    mod.skill_layer_report([], sevs)
    out = capsys.readouterr().out
    assert "composition:" in out
    assert "built on a proven sub-skill" in out
    assert "1 dependent(s) re-proofed" in out


def test_analyzer_reports_playbook_cutting_exploration_turns(p_metrics_dir, capsys):
    # tier-2 win: a cold run on a host takes many turns; once strategy is seeded, the same kind of task takes fewer. The analyzer must report HELPS.
    sig = sk.compute_sig("find people")
    p_task_row(sig, "llm", 60.0, turns=14, playbook_seeded=False)   # cold
    p_task_row(sig, "llm", 40.0, turns=8, playbook_seeded=True)     # seeded -> fewer turns
    mod = p_load_analyzer()
    tasks = mod.load(os.path.join(p_metrics_dir, "tasks.jsonl"))
    mod.playbook_report(tasks)
    out = capsys.readouterr().out
    assert "STRATEGIC PLAYBOOK" in out and "HELPS" in out and "NOT HELPING" not in out


def test_analyzer_flags_playbook_that_does_not_help(p_metrics_dir, capsys):
    # anti-ghost: memory is active (seeded) but seeded runs are NOT cheaper -> flag.
    sig = sk.compute_sig("stubborn task")
    p_task_row(sig, "llm", 60.0, turns=10, playbook_seeded=False)
    p_task_row(sig, "llm", 60.0, turns=12, playbook_seeded=True)    # seeded but MORE turns
    mod = p_load_analyzer()
    tasks = mod.load(os.path.join(p_metrics_dir, "tasks.jsonl"))
    mod.playbook_report(tasks)
    out = capsys.readouterr().out
    assert "NOT HELPING" in out


# --- helpers ---------------------------------------------------------------
def p_read(path):
    import json
    out = []
    if os.path.exists(path):
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
    return out


import pytest


@pytest.fixture
def p_metrics_dir():
    # the autouse conftest fixture already points metrics at a temp dir; surface it
    return os.environ["OPENSWARM_BROWSER_METRICS_DIR"]
