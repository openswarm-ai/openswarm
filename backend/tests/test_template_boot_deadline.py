"""The template's backend boot deadline must survive a first-boot pip install (found live).

Measured on a packaged build under real load (10 agents + ~20 runtimes): a fresh app's backend was
still at "Installing build dependencies" when run.sh's flat 60s wall clock fired, printed "Backend
failed to start within 60s. Aborting.", and the app card sat on "Starting preview" forever. The
install sentinel is written only after a successful pip install, so its absence IS the signal that
the slow path lies ahead; the deadline now keys off it. These pin that shape so a refactor cannot
quietly return to one flat number.
"""
import os
import re

P_TEMPLATE = os.path.join(os.path.dirname(__file__), "..", "apps", "outputs", "webapp_template")


def p_read(name: str) -> str:
    with open(os.path.join(P_TEMPLATE, name), encoding="utf-8") as fh:
        return fh.read()


def test_first_boot_gets_a_pip_sized_deadline():
    src = p_read("run.sh")
    assert ".openswarm_installed" in src, "the deadline must key off the install sentinel"
    waits = [int(m) for m in re.findall(r"MAX_WAIT=(\d+)", src)]
    assert len(waits) >= 2, "one flat MAX_WAIT is the bug: first boot and warm boot are different animals"
    assert max(waits) >= 300, f"first-boot budget {max(waits)}s cannot cover a pip install on a loaded machine"
    assert min(waits) <= 90, "the warm-boot budget must stay tight so a genuinely dead backend still fails fast"


def test_the_sentinel_paths_agree_between_the_two_scripts():
    # run.sh checks the sentinel that backend/run.sh writes; if either side renames it, the check
    # silently always takes the short deadline, which is the original bug wearing a new hat.
    outer = p_read("run.sh")
    inner = p_read(os.path.join("backend", "run.sh"))
    assert 'SENTINEL="$VENV_DIR/.openswarm_installed"' in inner
    assert 'backend/.venv/.openswarm_installed' in outer


def test_dead_process_still_fails_fast_regardless_of_deadline():
    src = p_read("run.sh")
    assert "Backend process died before becoming ready" in src, "a crashed backend must not wait out the long budget"
