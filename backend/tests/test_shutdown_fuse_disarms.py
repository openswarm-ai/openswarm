"""A completed shutdown must stand the hard-exit fuse down.

The fuse (ENG-223) exists so a wedged quit cannot strand the process tree: 10s after shutdown starts
it SIGKILLs every descendant and calls os._exit(0). Nothing ever cancelled it. In production that is
invisible, because the process is leaving anyway. Anywhere the app's lifespan runs inside a process
that keeps living, it is lethal: one lifespan exit in the backend test suite armed a fuse that fired
mid-run, and pytest died with NO summary and exit code 0, so roughly 42% of the suite silently never
ran while the run still looked like it had finished. Same class as ENG-219 and the unmarked-async
skip: a green-looking run that never executed.
"""

import os

import pytest

from backend.apps.service.shutdown_fuse import arm_shutdown_fuse, disarm_shutdown_fuse, fuse_armed

# The fuse walks the process tree with pgrep and is deliberately a no-op on Windows (arm returns without a timer), so there is nothing to stand down there.
pytestmark = pytest.mark.skipif(os.name == "nt", reason="the shutdown fuse is POSIX-only; arm is a no-op on Windows")


def test_arming_then_disarming_leaves_no_live_timer() -> None:
    arm_shutdown_fuse()
    assert fuse_armed() is True, "arming must actually start the fuse"
    disarm_shutdown_fuse()
    assert fuse_armed() is False, "a completed shutdown left a live os._exit timer behind"


def test_disarming_without_arming_is_harmless() -> None:
    disarm_shutdown_fuse()
    disarm_shutdown_fuse()
    assert fuse_armed() is False


def test_arming_twice_does_not_leave_an_orphan_timer() -> None:
    """The second arm must not abandon the first; an un-cancellable timer is exactly the thing that
    kills the runner later, long after the code that armed it has been forgotten."""
    arm_shutdown_fuse()
    arm_shutdown_fuse()
    assert fuse_armed() is True
    disarm_shutdown_fuse()
    assert fuse_armed() is False


def test_the_service_lifespan_disarms_on_a_clean_shutdown() -> None:
    """Wire-check the real caller, not just the helper: the fuse is armed at the top of the shutdown
    block and must be stood down at the bottom of the same block."""
    import inspect
    from backend.apps.service import service as svc
    src = inspect.getsource(svc.service_lifespan)
    assert "arm_shutdown_fuse()" in src
    assert "disarm_shutdown_fuse()" in src, "the lifespan arms the fuse and never stands it down"
    assert src.index("arm_shutdown_fuse()") < src.index("disarm_shutdown_fuse()")
