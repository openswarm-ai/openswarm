"""Parking an idle app freezes the WHOLE process tree, not just its root (ENG-311).

The runtime tracks one pid (`bash run.sh`) whose real work lives in grandchildren (backgrounded
pipeline -> vite). The old suspend signalled only the root: measured on the packaged build, run.sh
went TN while vite stayed SN at up to 125% CPU, so the idle pool cost a live dev server per parked
app, which is the shape of the 150MB/min growth users report (ENG-320). These tests build a real
three-level tree and assert OS-level state (ps STAT), both directions, because a "fix" that killed
the tree instead of freezing it would pass a one-directional check and destroy the fast reopen.
"""
import os
import signal
import subprocess
import time

import pytest

from backend.apps.outputs.runtime_proc import descendant_pids, resume_process_tree, suspend_process_tree

pytestmark = pytest.mark.skipif(os.name == "nt", reason="SIGSTOP path is POSIX-only by design")


class P_FakeProc:
    """The slice of asyncio.subprocess.Process the signal path reads."""

    def __init__(self, pid: int):
        self.pid = pid
        self.returncode = None


def p_stat(pid: int) -> str:
    out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return out


def p_spawn_tree():
    # bash -> (bash -> sleep) mirrors run.sh -> frontend/run.sh -> vite: the root backgrounds a
    # child script and waits, so the interesting pids are two levels down from the tracked one.
    # The trailing `; :` stops bash exec-optimizing the middle level away (a bare -c 'sleep' execs).
    root = subprocess.Popen(["bash", "-c", "bash -c 'sleep 300; :' & wait"])
    deadline = time.time() + 5
    while time.time() < deadline:
        kids = descendant_pids(root.pid)
        if len(kids) >= 2:
            return root, kids
        time.sleep(0.1)
    raise AssertionError("tree never grew two levels")


def test_descendants_are_found_two_levels_down():
    root, kids = p_spawn_tree()
    try:
        assert len(kids) >= 2, "must see the grandchild, not just the direct child"
    finally:
        root.kill()
        for k in kids:
            try:
                os.kill(k, signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_suspend_freezes_every_level_and_resume_thaws_them():
    root, kids = p_spawn_tree()
    proc = P_FakeProc(root.pid)
    try:
        suspend_process_tree(proc)
        time.sleep(0.3)
        for pid in [root.pid] + kids:
            assert "T" in p_stat(pid), f"pid {pid} not frozen; STAT={p_stat(pid)!r} (the ENG-311 no-op)"
        resume_process_tree(proc)
        time.sleep(0.3)
        for pid in [root.pid] + kids:
            assert "T" not in p_stat(pid), f"pid {pid} still frozen after resume; the fast reopen is dead"
    finally:
        resume_process_tree(proc)
        root.kill()
        for k in kids:
            try:
                os.kill(k, signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_dead_root_is_a_quiet_noop():
    root = subprocess.Popen(["bash", "-c", "true"])
    root.wait()
    proc = P_FakeProc(root.pid)
    proc.returncode = 0
    suspend_process_tree(proc)  # must not raise
    resume_process_tree(proc)


def test_none_proc_is_a_quiet_noop():
    suspend_process_tree(None)
    resume_process_tree(None)
