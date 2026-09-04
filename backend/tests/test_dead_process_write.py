"""Alex, 2026-09-03: 33 turns in 72 hours on two lanes died with `Cannot write to terminated process
(exit code: -11)`, every one carded as a generic provider error, none respawned. The CLI had
segfaulted between turns and the persistent client kept writing to the corpse. That shape is a dead
process like any SIGTERM/SIGKILL exit and takes the same respawn-and-resume, and when the code is a
crash signal the honest card names it and says to reopen the app."""

import os

from backend.apps.agents.core.error_classify import crash_signal_name, is_external_kill_error, process_exit_code

P_REAL = "Cannot write to terminated process (exit code: -11)"


def test_the_persistent_clients_dead_process_error_is_a_dead_process():
    assert is_external_kill_error(RuntimeError(P_REAL))
    assert process_exit_code(RuntimeError(P_REAL)) == -11
    assert crash_signal_name(RuntimeError(P_REAL)) == "segmentation fault"


def test_sigterm_and_sigkill_are_kills_not_crashes():
    e = RuntimeError("Command failed with exit code 143 (exit code: 143)")
    assert is_external_kill_error(e) and crash_signal_name(e) is None
    e = RuntimeError("Cannot write to terminated process (exit code: -9)")
    assert is_external_kill_error(e) and crash_signal_name(e) is None


def test_a_dead_process_with_a_real_error_on_stderr_is_left_to_the_other_branches():
    assert not is_external_kill_error(RuntimeError(P_REAL), extra_text="Error: API Error: 401 authentication_error")
    assert not is_external_kill_error(RuntimeError("some other failure"))
    assert process_exit_code(RuntimeError("line 11, in run")) is None


def test_the_exhausted_card_names_a_crash_and_the_envelope_carries_the_code():
    src = open(os.path.join(os.path.dirname(__file__), "..", "apps", "agents", "manager", "run", "handle_run_error.py")).read()
    assert "crash_signal_name(e)" in src
    assert "crashed twice in a row" in src and "DiagnosticReports" in src
    assert 'f"external_kill_respawn_exhausted:{process_exit_code(e)}"' in src
