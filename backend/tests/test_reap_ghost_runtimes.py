"""A reaper that misjudges ownership kills working apps, so ownership is the thing under test.

The first draft matched on the workspace path alone; a dry run on a live machine showed it would
have killed 14 running app runtimes whose backend was up. These pin the discriminator.
"""

import os
from unittest.mock import patch

import pytest

from backend.apps.outputs import reap_ghost_runtimes as mod


def p_ps(pid_args: str, pid_ppid: str):
    """Fake `ps` with two different outputs depending on the requested format."""
    class R:
        def __init__(self, out): self.stdout = out
    def run(cmd, **kw):
        return R(pid_args if "args=" in cmd[-1] or "pid=,args=" in " ".join(cmd) else pid_ppid)
    return run


def test_runtime_owned_by_a_live_backend_is_never_reaped():
    ws = os.path.abspath(mod.WORKSPACE_DIR)
    args = f"100 python -m uvicorn backend.main:app\n200 node {ws}/app/vite\n"
    ppid = "100 1\n200 100\n"
    with patch.object(mod.subprocess, "run", side_effect=p_ps(args, ppid)):
        assert mod.find_ghost_runtime_pids() == []


def test_runtime_whose_backend_died_is_reaped():
    ws = os.path.abspath(mod.WORKSPACE_DIR)
    # The CALLER is always a live backend (this code runs inside one), so the scan must show at
    # least ourselves; a fixture with "no uvicorn anywhere" models a world that cannot exist, and
    # the fail-closed guard rightly refuses to reap in it.
    args = f"50 python -m uvicorn backend.main:app\n200 node {ws}/app/vite\n"
    ppid = "50 1\n200 1\n"                      # ghost reparented to init, NOT under the backend
    with patch.object(mod.subprocess, "run", side_effect=p_ps(args, ppid)):
        assert mod.find_ghost_runtime_pids() == [200]


def test_ownership_is_inherited_through_the_bash_wrapper():
    """run.sh sits between the backend and vite; the walk must climb past it."""
    ws = os.path.abspath(mod.WORKSPACE_DIR)
    args = f"100 python -m uvicorn backend.main:app\n150 bash run.sh\n200 node {ws}/app/vite\n"
    ppid = "100 1\n150 100\n200 150\n"
    with patch.object(mod.subprocess, "run", side_effect=p_ps(args, ppid)):
        assert mod.find_ghost_runtime_pids() == []


def test_unrelated_processes_are_never_matched():
    """A user's own npm dev server elsewhere on the machine must be invisible to this."""
    args = "300 node /Users/someone/other-project/vite\n"
    ppid = "300 1\n"
    with patch.object(mod.subprocess, "run", side_effect=p_ps(args, ppid)):
        assert mod.find_ghost_runtime_pids() == []


def test_a_broken_ps_reaps_nothing_rather_than_guessing():
    def boom(*a, **k):
        raise OSError("ps unavailable")
    with patch.object(mod.subprocess, "run", side_effect=boom):
        assert mod.find_ghost_runtime_pids() == []
        assert mod.reap_ghost_runtimes() == 0


def test_stale_idle_runtimes_are_stopped_after_the_ttl(monkeypatch):
    """Frozen-idle is 0% CPU but holds memory and a port forever; past the TTL it must actually die."""
    import asyncio
    from backend.apps.outputs import runtime as rt_mod

    class P_FakeRuntime:
        def __init__(self) -> None:
            self.process = None
            self.running = True
            self.stopped = False

        async def stop(self) -> None:
            self.stopped = True

    monkeypatch.setattr(rt_mod, "resume_process_tree", lambda proc: None)
    m = rt_mod.AppRuntimeManager()
    old, fresh = P_FakeRuntime(), P_FakeRuntime()
    m.idle_lru["ws-old:1"] = old
    m.idle_lru["ws-new:1"] = fresh
    import time as p_time
    m.p_idle_since["ws-old:1"] = p_time.monotonic() - 3600
    m.p_idle_since["ws-new:1"] = p_time.monotonic()

    reaped = asyncio.run(m.reap_stale_idle(ttl_s=900))
    assert reaped == 1
    assert old.stopped and not fresh.stopped
    assert "ws-old:1" not in m.idle_lru and "ws-new:1" in m.idle_lru
    assert "ws-old:1" not in m.p_idle_since


def test_a_failed_backend_scan_reaps_nothing(monkeypatch):
    """We ARE a backend, so 'no live backends found' means the scan failed, not that everything is a
    ghost; without this, one slow `ps` under load turned the 10-minute sweep into a kill-all."""
    from backend.apps.outputs import reap_ghost_runtimes as rg
    monkeypatch.setattr(rg, "p_live_backend_pids", lambda: set())
    monkeypatch.setattr(rg, "p_ppid_map", lambda: {200: 1})
    class P_Out:
        stdout = f"200 node {rg.os.path.abspath(rg.WORKSPACE_DIR)}/ws-x/run\n"
    monkeypatch.setattr(rg.subprocess, "run", lambda *a, **k: P_Out())
    assert rg.find_ghost_runtime_pids() == []


def test_indeterminate_ancestry_is_never_a_ghost(monkeypatch):
    """A process missing from the ppid snapshot (spawned between the two ps calls) must be skipped,
    not killed: mid-session, that is a runtime that just started."""
    from backend.apps.outputs import reap_ghost_runtimes as rg
    monkeypatch.setattr(rg, "p_live_backend_pids", lambda: {50})
    monkeypatch.setattr(rg, "p_ppid_map", lambda: {300: 1})
    ws = rg.os.path.abspath(rg.WORKSPACE_DIR)
    class P_Out:
        stdout = f"300 node {ws}/ws-a/run\n999 node {ws}/ws-b/run\n"
    monkeypatch.setattr(rg.subprocess, "run", lambda *a, **k: P_Out())
    ghosts = rg.find_ghost_runtime_pids()
    assert 999 not in ghosts, "pid absent from the ppid map was treated as a ghost"
    assert ghosts == [300], "a genuinely orphaned pid (walks to init, no backend) still reaps"


def test_ghost_matched_despite_path_case_difference(monkeypatch):
    """macOS is case-insensitive, so a process can report .../openswarm/... while our resolved path
    is .../OpenSwarm/... (same folder). A case-sensitive match missed the ghost entirely; found live
    on a packaged smoke where 8 orphans survived a reap that logged 0."""
    from backend.apps.outputs import reap_ghost_runtimes as rg
    ws = rg.os.path.abspath(rg.WORKSPACE_DIR)
    lower_ws = ws.replace("OpenSwarm", "openswarm").replace("Openswarm", "openswarm")
    monkeypatch.setattr(rg, "p_live_backend_pids", lambda: {50})
    monkeypatch.setattr(rg, "p_ppid_map", lambda: {700: 1})  # orphan reparented to init
    class P_Out:
        stdout = f"50 python -m uvicorn backend.main:app\n700 bash {lower_ws}/ws-x/backend/run.sh\n"
    monkeypatch.setattr(rg.subprocess, "run", lambda *a, **k: P_Out())
    assert rg.find_ghost_runtime_pids() == [700], "a case-different path must still match the ghost"


def test_an_orphan_is_found_by_its_CWD_when_argv_hides_the_path(monkeypatch):
    """An app's backend runs as `python -u backend.py` with cwd=<workspace>, so the workspace path is
    nowhere in its argv. An argv-only scan was structurally blind to exactly the ghost we most want
    dead; found live on a packaged build where orphaned app backends survived every reap."""
    from backend.apps.outputs import reap_ghost_runtimes as rg
    ws = rg.os.path.abspath(rg.WORKSPACE_DIR)
    monkeypatch.setattr(rg, "p_live_backend_pids", lambda: {50})
    monkeypatch.setattr(rg, "p_ppid_map", lambda: {900: 1})
    monkeypatch.setattr(rg, "p_cwd_map", lambda needle: {900: ws + "/app-7"})
    class P_Out:
        stdout = "50 python -m uvicorn backend.main:app\n900 python3 -u backend.py\n"
    monkeypatch.setattr(rg.subprocess, "run", lambda *a, **k: P_Out())
    assert rg.find_ghost_runtime_pids() == [900], "a cwd-only orphan must still be reaped"


def test_a_cwd_orphan_owned_by_a_live_backend_is_spared(monkeypatch):
    """The cwd path must obey the same ancestry rule: a working app is not a ghost."""
    from backend.apps.outputs import reap_ghost_runtimes as rg
    ws = rg.os.path.abspath(rg.WORKSPACE_DIR)
    monkeypatch.setattr(rg, "p_live_backend_pids", lambda: {50})
    monkeypatch.setattr(rg, "p_ppid_map", lambda: {900: 50, 50: 1})
    monkeypatch.setattr(rg, "p_cwd_map", lambda needle: {900: ws + "/app-7"})
    class P_Out:
        stdout = "50 python -m uvicorn backend.main:app\n900 python3 -u backend.py\n"
    monkeypatch.setattr(rg.subprocess, "run", lambda *a, **k: P_Out())
    assert rg.find_ghost_runtime_pids() == [], "a live backend's own app runtime must never be killed"


@pytest.mark.skipif(os.name == "nt", reason="SIGSTOP/SIGCONT freezing is POSIX-only; the reaper never pauses runtimes on Windows")
def test_a_frozen_ghost_is_thawed_before_being_signalled(monkeypatch):
    """Idle app runtimes are parked with SIGSTOP, and a STOPPED process never handles SIGTERM: it
    queues it and lives forever. Found live as a frozen `bash run.sh` that had survived every reap
    for 2 days 21 hours. CONT must precede TERM, and anything still breathing gets KILL."""
    import signal as sg
    from backend.apps.outputs import reap_ghost_runtimes as rg
    monkeypatch.setattr(rg, "find_ghost_runtime_pids", lambda: [4242])
    monkeypatch.setattr(rg, "REAP_GRACE_SECONDS", 0.0)
    monkeypatch.setattr(rg, "kill_descendant_tree", lambda pid, sig: None)
    sent = []
    alive = {4242: True}
    def p_kill(pid, sig):
        if sig == 0:
            if not alive.get(pid): raise ProcessLookupError()
            return
        sent.append(sig)
        if sig == sg.SIGKILL: alive[pid] = False
    monkeypatch.setattr(rg.os, "kill", p_kill)
    rg.reap_ghost_runtimes()
    assert sg.SIGCONT in sent, "a stopped ghost never receives TERM unless it is thawed first"
    assert sent.index(sg.SIGCONT) < sent.index(sg.SIGTERM), "CONT must come before TERM"
    assert sg.SIGKILL in sent, "a ghost that ignored TERM must be escalated, not left running"
