"""Out-of-loop event-loop liveness watchdog (lifted from hermes-agent
gateway/shutdown_watchdog.py::start_loop_liveness_watchdog, MIT; their incident #66892: the
asyncio loop froze and every recovery path needed that same frozen loop, so a wedged-but-alive
gateway sat as a zombie forever, because supervisors only restart DEAD processes).

Our three watchdog layers (sidecar heartbeat, delegation backstop, wedge unwedger) are all
asyncio tasks INSIDE the backend loop; if that loop wedges, none of them can fire, and Electron's
respawn only triggers on process exit. This plain OS thread probes the loop with
call_soon_threadsafe; three consecutive unanswered probes means the loop is provably frozen, so
it dumps every thread's stack to a forensics file and hard-exits with the restart code Electron's
supervisor already backs off on.

Hermes's own rules kept: the watchdog never shares a fate with the loop it watches (daemon OS
thread), every failure inside the watchdog fails OPEN (returns, never kills), and generous
strikes so a slow-but-alive loop (sync httpx on the loop is a known 2s block here) never dies."""

import asyncio
import faulthandler
import logging
import os
import threading
import time
from typing import Optional

from typeguard import typechecked

from backend.config.paths import DATA_ROOT

logger = logging.getLogger(__name__)

PROBE_INTERVAL_S = 30.0
# 20s, not 10s: a big session persist to a slow mount or the unwedger's 10s ps timeout can hold the loop that long and still be alive; a frozen loop is frozen forever, so the longer probe costs 30s of detection and nothing else (ENG-366).
PROBE_TIMEOUT_S = 20.0
MAX_STRIKES = 3
# 75 = EX_TEMPFAIL, hermes's "restart me" exit language; Electron respawns any non-zero exit.
RESTART_EXIT_CODE = 75
DUMP_PATH = os.path.join(DATA_ROOT, "loop-watchdog-dump.log")
# Left behind by a watchdog exit so the next boot knows the last life died of a frozen loop, not of whatever workflow happened to be mid-fire.
WATCHDOG_EXIT_MARKER = os.path.join(DATA_ROOT, "loop-watchdog-exit")


@typechecked
def consume_watchdog_exit_marker() -> bool:
    try:
        os.unlink(WATCHDOG_EXIT_MARKER)
        return True
    except OSError:
        return False


@typechecked
def dump_and_exit(strikes: int) -> None:
    try:
        logger.critical(f"backend event loop missed {strikes} consecutive liveness probes; dumping stacks and exiting {RESTART_EXIT_CODE} so Electron respawns a working process")
    except Exception:
        pass
    try:
        with open(DUMP_PATH, "a", encoding="utf-8") as fh:
            fh.write(f"\n=== loop watchdog fired pid={os.getpid()} t={time.time():.0f} strikes={strikes} ===\n")
            fh.flush()
            faulthandler.dump_traceback(file=fh, all_threads=True)
            fh.write("=== end dump ===\n")
    except Exception:
        pass
    try:
        faulthandler.dump_traceback(all_threads=True)
    except Exception:
        pass
    try:
        with open(WATCHDOG_EXIT_MARKER, "w", encoding="utf-8") as fh:
            fh.write(f"{time.time():.0f}\n")
    except Exception:
        pass
    os._exit(RESTART_EXIT_CODE)


@typechecked
def start_loop_liveness_watchdog(loop: "asyncio.AbstractEventLoop") -> Optional[threading.Event]:
    """Arm the watchdog against `loop`. Returns the stop event, or None when arming failed
    (fail open: a backend without a watchdog beats a backend killed by a broken one)."""
    stop_event = threading.Event()

    def p_wait_for_probe(probe: threading.Event) -> Optional[bool]:
        deadline = time.monotonic() + PROBE_TIMEOUT_S
        while True:
            if stop_event.is_set():
                return None
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return probe.is_set()
            if probe.wait(timeout=min(remaining, 0.05)):
                return True

    def p_watchdog() -> None:
        strikes = 0
        while not stop_event.wait(timeout=PROBE_INTERVAL_S):
            probe = threading.Event()
            try:
                loop.call_soon_threadsafe(probe.set)
            except RuntimeError:
                # A closed loop is a normally exiting process; no backstop needed.
                return
            except Exception:
                logger.debug("loop liveness probe scheduling failed", exc_info=True)
                return
            responded = p_wait_for_probe(probe)
            if responded is None:
                return
            if responded:
                strikes = 0
                continue
            strikes += 1
            logger.warning(f"backend event loop missed liveness probe ({strikes}/{MAX_STRIKES})")
            if strikes >= MAX_STRIKES and not stop_event.is_set():
                dump_and_exit(strikes)
                return

    try:
        threading.Thread(target=p_watchdog, daemon=True, name="loop-liveness-watchdog").start()
    except Exception:
        logger.debug("failed to start loop liveness watchdog", exc_info=True)
        return None
    return stop_event
