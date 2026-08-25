import inspect
"""Clause: every surfaced error carries the full flight envelope.

`cli_binary_missing` shipped without one and nobody noticed, because the only way to see it is to
force a failure class that cannot be forced on a dev box (the SDK falls back to the system `claude`,
then to ~/.claude/local/claude). An audit of the source is the sensor that does not need the repro."""

import re

from backend.apps.agents.manager.run import handle_run_error as p_handler_mod
from backend.apps.agents import agent_manager as p_manager_mod

P_SOURCES = {
    "handle_run_error": p_handler_mod,
    "agent_manager": p_manager_mod,
}


def p_diagnostic_blocks(src: str):
    return re.findall(r'submit_diagnostic\(\{(.*?)\}\)', src, re.S)


def test_every_error_diagnostic_carries_a_flight_envelope():
    import inspect
    missing = []
    for name, mod in P_SOURCES.items():
        for block in p_diagnostic_blocks(inspect.getsource(mod)):
            kind = re.search(r'"kind":\s*"([a-z_]+)"', block)
            kind = kind.group(1) if kind else "?"
            # `recovered` rows are near-miss ledger entries, built by record_recovery, not error cards.
            if kind == "recovered":
                continue
            if '"flight"' not in block:
                missing.append(f"{name}:{kind}")
    assert not missing, f"error diagnostics with no envelope: {missing}"


def test_the_cli_missing_class_specifically_is_covered():
    import inspect
    src = inspect.getsource(p_handler_mod)
    block = [b for b in p_diagnostic_blocks(src) if '"cli_binary_missing"' in b]
    assert block, "the cli_binary_missing diagnostic disappeared"
    assert '"flight"' in block[0]


def test_silent_quit_diagnostic_carries_a_full_envelope():
    """A silent quit is the hardest class to diagnose later, so it must not ship envelope-less.
    Found live: empty_finish_nudge was the ONE family writing only kind/model/session_id."""
    # The telemetry moved next door when empty_finish.py crossed the 300-line ceiling; the assertion
    # is about the ENVELOPE, so it follows the code rather than pinning a file name.
    import backend.apps.agents.manager.run.empty_finish_telemetry as ef
    src = inspect.getsource(ef.report_nudge)
    assert "build_envelope" in src, "empty_finish_nudge must attach a flight envelope"
    assert '"flight"' in src, "the envelope must ride under the standard 'flight' key"
