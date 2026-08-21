"""Pins the out-of-loop watchdog (hermes #66892 lift): a frozen loop is detected and killed with
forensics; a healthy or merely-slow loop is never touched; arming failures fail open."""

import subprocess
import sys
import textwrap

from backend.apps.system import loop_liveness_watchdog as w


def p_run_child(code: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", textwrap.dedent(code)], capture_output=True, text=True, timeout=timeout)


P_PRELUDE = """
import asyncio, sys, time
sys.path.insert(0, ".")
from backend.apps.system import loop_liveness_watchdog as w
w.PROBE_INTERVAL_S = 0.3
w.PROBE_TIMEOUT_S = 0.3
w.DUMP_PATH = "/tmp/loop_watchdog_test_dump.log"
"""


def test_wedged_loop_is_killed_with_forensics(tmp_path):
    code = P_PRELUDE + """
async def main():
    loop = asyncio.get_running_loop()
    assert w.start_loop_liveness_watchdog(loop) is not None
    time.sleep(30)  # wedge the loop with a sync sleep: probes can never run

asyncio.run(main())
print("SURVIVED")
"""
    r = p_run_child(code)
    assert r.returncode == w.RESTART_EXIT_CODE, f"expected exit {w.RESTART_EXIT_CODE}, got {r.returncode}: {r.stderr[:300]}"
    assert "SURVIVED" not in r.stdout
    dump = open("/tmp/loop_watchdog_test_dump.log").read()
    assert "loop watchdog fired" in dump
    assert "Thread" in dump, "faulthandler stack dump missing"


def test_healthy_loop_never_killed():
    code = P_PRELUDE + """
async def main():
    loop = asyncio.get_running_loop()
    stop = w.start_loop_liveness_watchdog(loop)
    await asyncio.sleep(2.5)  # many probe intervals, loop responsive throughout
    stop.set()

asyncio.run(main())
print("SURVIVED")
"""
    r = p_run_child(code)
    assert r.returncode == 0 and "SURVIVED" in r.stdout


def test_slow_but_alive_loop_survives_single_strikes():
    """Blocks shorter than MAX_STRIKES consecutive misses must never kill (sync httpx on the loop is a known 2s block)."""
    code = P_PRELUDE + """
async def main():
    loop = asyncio.get_running_loop()
    stop = w.start_loop_liveness_watchdog(loop)
    for _ in range(3):
        time.sleep(0.5)   # one missed probe worth of block
        await asyncio.sleep(0.7)  # then responsive again: strikes reset
    stop.set()

asyncio.run(main())
print("SURVIVED")
"""
    r = p_run_child(code)
    assert r.returncode == 0 and "SURVIVED" in r.stdout


def test_closed_loop_ends_watchdog_quietly():
    code = P_PRELUDE + """
async def main():
    loop = asyncio.get_running_loop()
    w.start_loop_liveness_watchdog(loop)

asyncio.run(main())
time.sleep(1.2)  # loop closed; watchdog must not fire on a normally exiting process
print("SURVIVED")
"""
    r = p_run_child(code)
    assert r.returncode == 0 and "SURVIVED" in r.stdout


def test_the_exit_leaves_a_marker_the_next_boot_can_consume(tmp_path, monkeypatch):
    """ENG-366: record_boot reads this marker to tell a watchdog restart from a workflow-caused death."""
    import os
    marker = str(tmp_path / "loop-watchdog-exit")
    monkeypatch.setattr(w, "WATCHDOG_EXIT_MARKER", marker)
    monkeypatch.setattr(w, "DUMP_PATH", str(tmp_path / "dump.log"))
    exits = []
    monkeypatch.setattr(os, "_exit", lambda code: exits.append(code))
    w.dump_and_exit(3)
    assert exits == [w.RESTART_EXIT_CODE]
    assert os.path.exists(marker)
    assert w.consume_watchdog_exit_marker() is True
    assert not os.path.exists(marker)
    assert w.consume_watchdog_exit_marker() is False
