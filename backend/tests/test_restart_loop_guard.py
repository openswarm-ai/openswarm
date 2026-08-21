"""Pins the scheduled-run restart-loop breaker (hermes #30719 analog): both legs required to
trip, survival forgives, and every failure mode fails OPEN."""

import json

from backend.apps.workflows import restart_loop_guard as g


def p_fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(g, "DATA_DIR", str(tmp_path))
    g.clear()


def test_normal_operator_restarts_never_trip(tmp_path, monkeypatch):
    p_fresh(tmp_path, monkeypatch)
    g.record_boot(now=1000.0)
    g.record_boot(now=1400.0)
    assert g.is_tripped("wf1", now=1400.0) is False


def test_boot_storm_alone_does_not_trip_an_uninvolved_workflow(tmp_path, monkeypatch):
    p_fresh(tmp_path, monkeypatch)
    for t in (1000.0, 1010.0, 1020.0):
        g.record_boot(now=t)
    assert g.is_tripped("wf1", now=1020.0) is False


def test_the_30719_loop_trips(tmp_path, monkeypatch):
    """Workflow fires, process dies, boot implicates it, twice, inside a boot storm: TRIP."""
    p_fresh(tmp_path, monkeypatch)
    g.record_boot(now=1000.0)
    g.mark_firing("wf1")
    g.record_boot(now=1010.0)  # died mid-fire -> implication 1
    g.mark_firing("wf1")
    g.record_boot(now=1020.0)  # died mid-fire again -> implication 2, boots = 3
    assert g.is_tripped("wf1", now=1020.0) is True
    assert g.is_tripped("wf-other", now=1020.0) is False


def test_survival_forgives_implications(tmp_path, monkeypatch):
    p_fresh(tmp_path, monkeypatch)
    g.record_boot(now=1000.0)
    g.mark_firing("wf1")
    g.record_boot(now=1010.0)
    g.mark_firing("wf1")
    g.clear_firing("wf1")  # the run finished this life: proof it doesn't kill the process
    g.record_boot(now=1020.0)
    assert g.is_tripped("wf1", now=1020.0) is False


def test_old_boots_age_out_of_the_window(tmp_path, monkeypatch):
    p_fresh(tmp_path, monkeypatch)
    g.record_boot(now=1000.0)
    g.mark_firing("wf1")
    g.record_boot(now=1010.0)
    g.mark_firing("wf1")
    g.record_boot(now=1020.0)
    assert g.is_tripped("wf1", now=1020.0) is True
    assert g.is_tripped("wf1", now=1020.0 + g.WINDOW_SECONDS + 1) is False


def test_corrupt_state_fails_open(tmp_path, monkeypatch):
    p_fresh(tmp_path, monkeypatch)
    with open(g.p_state_path(), "w") as f:
        f.write("{corrupt json!!")
    assert g.is_tripped("wf1") is False
    g.record_boot()  # must not raise
    assert isinstance(json.load(open(g.p_state_path())), dict)


def test_unwritable_dir_fails_open(tmp_path, monkeypatch):
    monkeypatch.setattr(g, "DATA_DIR", "/nonexistent-root-path-xyz/nope")
    assert g.is_tripped("wf1") is False
    g.record_boot()
    g.mark_firing("wf1")
    g.clear_firing("wf1")


def test_a_watchdog_death_implicates_nobody(tmp_path, monkeypatch):
    """ENG-366: the loop watchdog's own hard exit is a frozen backend, not a workflow's doing; a
    workflow mid-fire at three such deaths in a row must stay unimplicated and untripped, while the
    same three deaths without the marker trip it (the control)."""
    p_fresh(tmp_path, monkeypatch)
    monkeypatch.setattr(g, "consume_watchdog_exit_marker", lambda: True)
    for t in (1000.0, 1010.0, 1020.0):
        g.mark_firing("wf1")
        g.record_boot(now=t)
    assert g.is_tripped("wf1", now=1020.0) is False
    p_fresh(tmp_path, monkeypatch)
    monkeypatch.setattr(g, "consume_watchdog_exit_marker", lambda: False)
    for t in (1000.0, 1010.0, 1020.0):
        g.mark_firing("wf1")
        g.record_boot(now=t)
    assert g.is_tripped("wf1", now=1020.0) is True
