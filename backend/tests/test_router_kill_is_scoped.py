"""The suite must never kill a router it did not start. That router is the user's running app.

Measured 2026-08-24 (ENG-393): `pytest backend/tests` reached `ensure_running()`, which did
`pkill -f next-server` whenever OPENSWARM_PACKAGED was unset. 9router runs as a bare `next-server`,
so that command matched by NAME and killed every one on the machine: the packaged OpenSwarm the
developer had open, another worktree's dev stack, an unrelated Next.js project. Same batch, same
commit: backend up = hang at test 22 or 3 failures; ports clear = 159/161 passed.
"""

import os
import sys

from backend.apps.nine_router import process as p_proc

SRC = "backend/apps/nine_router/process.py"


def test_the_kill_is_scoped_to_our_own_port():
    src = open(SRC).read()
    # The docstring still names the old command; what must be gone is any INVOCATION of it, and a
    # subprocess call has to quote its argv.
    for bad in ('"pkill"', "'pkill'", '"pgrep"', "'pgrep'"):
        assert bad not in src, f"{bad} matches by process NAME and reaches processes we do not own"
    i = src.index("def stale_router_pids")
    body = src[i:i + 900]
    assert 'f"-iTCP:{NINE_ROUTER_PORT}"' in body and '"-sTCP:LISTEN"' in body


def test_a_test_run_is_held_by_a_declared_signal_first():
    why = p_proc.router_kill_held_because()
    assert why, "under pytest it must always be held"
    assert os.environ.get("OSW_NEVER_KILL_ROUTER") == "1", "conftest sets the DECLARED signal"


def test_the_declared_signal_holds_it_without_pytest(monkeypatch):
    # The incidental signal stays a fallback: the day pytest is importable somewhere unexpected must
    # not be the day this behaviour silently changes.
    monkeypatch.setenv("OSW_NEVER_KILL_ROUTER", "1")
    monkeypatch.delitem(sys.modules, "pytest", raising=False)
    assert p_proc.router_kill_held_because() == "this process was told never to"


def test_a_real_dev_boot_can_still_replace_a_stale_router(monkeypatch):
    # The feature exists so `next dev` can take over from a stale standalone build. Holding it
    # always would be the opposite bug: a dev stack stuck on yesterday's router, silently.
    monkeypatch.delenv("OSW_NEVER_KILL_ROUTER", raising=False)
    monkeypatch.delitem(sys.modules, "pytest", raising=False)
    assert p_proc.router_kill_held_because() is None


def test_the_hold_says_which_router_it_just_left_alone():
    src = open(SRC).read()
    i = src.index("is not ours and %s")
    assert "logger.warning" in src[i - 200:i], "a guard may never disable itself in silence"
    assert "NINE_ROUTER_PORT" in src[i:i + 300]


def test_finding_no_listener_is_not_an_error():
    # lsof missing, or nothing listening, must read as "nothing to kill", never as a crash on boot.
    assert isinstance(p_proc.stale_router_pids(), list)
