"""Temporary time-to-first-token phase probe for the send->first-token A/B sweep. A no-op unless
OSW_TTFT_PROBE=1, so it never spams a normal run. Strip once the persistent-client work lands."""

import logging
import os
import time

from typeguard import typechecked

logger = logging.getLogger(__name__)

P_TTFT_ENABLED = os.environ.get("OSW_TTFT_PROBE") == "1"


@typechecked
def ttft_probe(session_id: str, phase: str, **extra: object) -> None:
    """One monotonic phase stamp for the TTFT breakdown; the A/B parser reads `phase=<name> mono=<t>`.
    A no-op unless OSW_TTFT_PROBE=1, and it swallows any error so instrumentation can NEVER break a turn."""
    if not P_TTFT_ENABLED:
        return
    try:
        tail = " ".join(f"{k}={v}" for k, v in extra.items())
        logger.warning(f"[TTFT] sid={session_id} phase={phase} mono={time.monotonic():.4f} {tail}".rstrip())
    except Exception:
        pass
