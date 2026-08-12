"""SIGTERM arms a hard exit fuse (ENG-223): the quit path can wedge mid-shutdown (measured live: a
quit racing a pending update left uvicorn hung 8+ minutes with its whole agent-CLI tree orphaned at
~700MB), so if graceful shutdown has not finished FUSE_S after TERM, the fuse kills our process
tree and exits. A daemon thread, so a wedged event loop cannot block it."""

import os
import subprocess
import threading
from typing import List, Optional

from typeguard import typechecked

FUSE_S = 10.0


@typechecked
def p_descendant_pids() -> List[int]:
    pids: List[int] = []
    frontier: List[int] = [os.getpid()]
    for depth in range(6):
        next_frontier: List[int] = []
        for parent in frontier:
            try:
                out = subprocess.run(
                    ["pgrep", "-P", str(parent)], capture_output=True, text=True, timeout=2,
                ).stdout
            except Exception:
                continue
            for tok in out.split():
                try:
                    next_frontier.append(int(tok))
                except ValueError:
                    pass
        pids.extend(next_frontier)
        if not next_frontier:
            break
        frontier = next_frontier
    return pids


@typechecked
def p_burn() -> None:
    for pid in p_descendant_pids():
        try:
            os.kill(pid, 9)
        except Exception:
            pass
    os._exit(0)


p_armed: Optional[threading.Timer] = None


@typechecked
def arm_shutdown_fuse() -> None:
    """Called at lifespan-shutdown START (already past TERM), so no signal handling: just the timer. Touching signal.signal here would clobber uvicorn's asyncio-installed handlers."""
    global p_armed
    if os.name == "nt":
        return
    disarm_shutdown_fuse()
    p_armed = threading.Timer(FUSE_S, p_burn)
    p_armed.daemon = True
    p_armed.start()


@typechecked
def fuse_armed() -> bool:
    """True while a fuse is still going to fire. cancel() only sets Timer.finished and leaves the
    thread alive for a moment, so liveness is the wrong question to ask."""
    return p_armed is not None and not p_armed.finished.is_set()


@typechecked
def disarm_shutdown_fuse() -> None:
    """Shutdown finished on its own, so the fuse has nothing left to save and must not go off.

    Nothing used to disarm it. Harmless in production (the process is leaving anyway) but lethal
    anywhere the app's lifespan runs and the process keeps living: in the backend test suite one
    lifespan exit armed a fuse that detonated 10s later mid-run, SIGKILLing children and calling
    os._exit(0). pytest died with no summary and exit code 0, so ~42% of the suite silently never
    ran and the run still looked like it had finished.
    """
    global p_armed
    if p_armed is not None:
        p_armed.cancel()
        p_armed = None
