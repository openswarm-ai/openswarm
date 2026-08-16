"""Restart 9Router right after a subscription connect completes (ENG-315).

A freshly connected subscription can sit dead until OpenSwarm restarts, dying on rate-limit-shaped
errors. Every layer WE own reads live (picker payload, provider env, route resolution: all
verified no-restart on packaged exp.9), so the stale state is inside the router process itself:
0.3.60 stamps failing connections with `modelLock_<model>` cooldowns + `testStatus:"unavailable"`
in its in-memory DB, and dispatch skips locked connections, which reads as a rate limit to the
caller. A router restart re-reads db.json and was measured to land every arm in a known-good state
within ~10s, which is exactly why "restart OpenSwarm" cures the reported bug: the app restart's
only relevant side effect IS the router restart. So do just that part, at the connect chokepoint.

Safe mid-session: the CLI retries provider 5xx itself (10 attempts / 30s), and the kill-drill on
the packaged build showed an in-flight agent surviving a router bounce with the session resuming.
"""
import asyncio
import logging

from typeguard import typechecked

from backend.apps.nine_router import process as p_router

logger = logging.getLogger(__name__)


@typechecked
async def bounce_router_after_connect(provider: str) -> bool:
    """Sequential stop -> ensure_running. Never two live routers (a parallel pair once rotated one
    token family to death); never raises, a failed bounce leaves the watchdog to revive."""
    try:
        logger.info(f"bouncing 9Router after {provider} connect so its dispatch state is rebuilt")
        p_router.stop()
        await asyncio.sleep(0.5)
        await p_router.ensure_running()
        return p_router.is_running()
    except Exception:
        logger.warning("post-connect router bounce failed; watchdog will revive", exc_info=True)
        return False
