"""A ceiling on how fast the HARNESS may start turns on the user's account.

Measured across 79 installs over 14 days: the median install starts **1** machine-initiated turn
per minute and 76 of 79 never pass 10. Three outliers sit at 16, 48 and **186 per minute**, and the
186 install is the same one that produced 44 of the 45 policy blocks in that window. Association,
not proof, but an unbounded self-heal loop spending someone's subscription is a bug at any rate.

Why a TOKEN BUCKET and not a semaphore: a bucket can only ever DELAY, so it cannot deadlock. A
parent waiting on a child while holding a slot is the classic way a gate like this eats an app, and
that failure is unrepresentable here because nothing is ever held.

What it deliberately does NOT cover: a human pressing send (never delayed, at any rate), and the
provider requests the CLI makes inside a turn (we do not send those; only 9router sees them). This
bounds the one thing we actually control, which is how often we start a turn nobody asked for.
"""

import asyncio
import logging
import time
from typing import Dict, List

from typeguard import typechecked

logger = logging.getLogger(__name__)

# Sits in the gap between the busiest legitimate install (9/min) and the pathological ones (16, 48,
# 186). Raising it needs a new measurement, not a hunch: a ceiling nothing reaches is not a ceiling.
MACHINE_TURNS_PER_MINUTE = 20
WINDOW_S = 60.0
# Waking in slices rather than one long sleep: the hold stays responsive to a window that rolls
# early, and a caller checking for a user message afterwards is never more than a slice stale.
SLICE_S = 2.0

p_starts: List[float] = []
p_stats: Dict[str, float] = {"admitted": 0, "delayed": 0, "delayed_s": 0.0}


@typechecked
def wait_needed(now: float) -> float:
    """Seconds until a slot frees, 0 when one is free. Pure, so the ceiling is testable without sleeping."""
    while p_starts and now - p_starts[0] > WINDOW_S:
        p_starts.pop(0)
    if len(p_starts) < MACHINE_TURNS_PER_MINUTE:
        return 0.0
    return max(0.0, WINDOW_S - (now - p_starts[0]))


@typechecked
async def wait_for_machine_turn_slot(session_id: str, reason: str) -> None:
    """Hold a machine-started turn until the account has room. Never rejects, never drops work."""
    waited = 0.0
    said = False
    while True:
        delay = wait_needed(time.monotonic())
        if delay <= 0:
            break
        waited += min(delay, SLICE_S)
        # Says which session it is holding and why: a guard that throttles in silence reads to the
        # next person as "the app randomly got slow". Once per hold, not once per slice.
        if not said:
            said = True
            logger.warning(
                f"machine-turn ceiling reached ({MACHINE_TURNS_PER_MINUTE}/min): holding the {reason} "
                f"for {session_id} up to {delay:.1f}s. A human send is never held."
            )
        await asyncio.sleep(min(delay, SLICE_S))
    p_starts.append(time.monotonic())
    p_stats["admitted"] += 1
    if waited > 0:
        p_stats["delayed"] += 1
        p_stats["delayed_s"] += waited


@typechecked
def gate_report() -> str:
    """What the ceiling actually did, so 'it never fires' is a fact rather than an assumption."""
    return (f"machine-turn gate: {int(p_stats['admitted'])} starts admitted, "
            f"{int(p_stats['delayed'])} held, {p_stats['delayed_s']:.1f}s total")


@typechecked
def admitted_count() -> int:
    return int(p_stats["admitted"])


@typechecked
def reset_for_test() -> None:
    """Forget the window. Named for what it is, so nobody calls it from production by accident."""
    p_starts.clear()
    p_stats.update({"admitted": 0, "delayed": 0, "delayed_s": 0.0})


@typechecked
def note_start_for_test(n: int) -> None:
    """Pretend n machine-started turns just happened, so a ceiling test needs no real turns."""
    now = time.monotonic()
    p_starts.extend([now] * n)


@typechecked
def roll_window_for_test(seconds: float) -> None:
    """Age every recorded start, so a test can reach the far side of the window without sleeping it."""
    p_starts[:] = [t - seconds for t in p_starts]
