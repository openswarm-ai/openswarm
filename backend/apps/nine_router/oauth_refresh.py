"""Keep every subscription login alive while the app runs, and say the truth the moment one cannot be.

A login dies quietly: the short-lived token lapses while the app sits idle, nobody refreshes it, and
the next chat on it 401s. 9Router refreshes a token only when something asks it to test the
connection, and it refreshes only inside the last five minutes before expiry. So this asks, on a
clock, for every OAuth connection that is inside the margin. Two outcomes matter: the router
refreshed (nothing to say), or the router reports "refresh failed" / "expired", which is a verdict
waiting cannot change, so the dead-login pill goes up now instead of after the next failed chat.

Deliberately narrow: only the router's own test route is used (it owns the tokens and db.json), a
lent connection (no refresh token, the cloud rotates it) is left to lent_credential_refresh, and a
router that is down or busy is retried on the next tick, never reported.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Dict, List, Optional, Set

import httpx
from typeguard import typechecked

from backend.apps.nine_router import process
from backend.apps.nine_router.process import NINE_ROUTER_API, is_running

logger = logging.getLogger(__name__)

# The router refreshes inside its own 5-minute window; ask a little earlier so a slow refresh still lands before the deadline.
REFRESH_MARGIN_S = 20 * 60
CHECK_INTERVAL_S = 5 * 60
TEST_TIMEOUT_S = 40.0

P_DEAD_MARKERS = ("refresh failed", "token expired", "invalid or revoked", "sign in")


@typechecked
def p_seconds_left(expires_at: Optional[str], now: Optional[float] = None) -> Optional[float]:
    if not expires_at:
        return None
    try:
        t = datetime.fromisoformat(expires_at.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None
    return t - (time.time() if now is None else now)


@typechecked
def lent_connection_ids() -> Set[str]:
    """A lent login (the cloud pool's) has no refresh token of its own; the cloud rotates it, this loop must not."""
    return {str(c.get("id") or "") for c in process.read_persisted_connections() if not c.get("refreshToken")}


@typechecked
def connections_due(conns: List[Dict], now: Optional[float] = None, lent: Optional[Set[str]] = None) -> List[Dict]:
    """OAuth connections inside the margin (or already past it), from the router's LIVE view, which redacts
    tokens; lent logins are named by id from the persisted file, the one place the missing token shows."""
    due = []
    for c in conns:
        if c.get("authType") != "oauth" or not c.get("isActive", True):
            continue
        if lent and str(c.get("id") or "") in lent:
            continue
        left = p_seconds_left(c.get("expiresAt"), now)
        if left is None or left > REFRESH_MARGIN_S:
            continue
        due.append(c)
    return due


@typechecked
def verdict_from_test(result: Dict) -> str:
    """"refreshed" (the router renewed it), "healthy" (valid, nothing to do), "dead" (the router itself says
    waiting cannot help), or "unknown" (anything else, including a router hiccup)."""
    if result.get("valid") is True:
        return "refreshed" if result.get("refreshed") else "healthy"
    err = str(result.get("error") or "").lower()
    if result.get("valid") is False and any(m in err for m in P_DEAD_MARKERS):
        return "dead"
    return "unknown"


async def test_connection(client: httpx.AsyncClient, connection_id: str) -> Dict:
    try:
        # POST, not GET: 0.3.60 answers 405 to a GET, and the loop ran for a day reading that as "unknown" and renewing nothing.
        r = await client.post(f"{NINE_ROUTER_API}/providers/{connection_id}/test")
        return r.json() if r.status_code == 200 else {"error": f"HTTP {r.status_code}"}
    except Exception as e:
        return {"error": str(e)}


p_last_unknown: Dict[str, str] = {}


@typechecked
def note_unknown(provider: str, answer: Dict) -> None:
    """An answer the loop cannot read is logged the first time it changes shape, never swallowed: a silent
    "unknown" every five minutes is a guard that stopped guarding."""
    shape = str(answer)[:200]
    if p_last_unknown.get(provider) == shape:
        return
    p_last_unknown[provider] = shape
    logger.warning(f"[oauth-refresh] {provider}: the router's answer could not be read as a verdict, so this login is NOT being renewed by the loop: {shape}")


async def refresh_pass(now: Optional[float] = None) -> Dict[str, str]:
    """One tick: test every due connection; returns {provider: verdict}. Reports a dead login through the
    same door the boot probe and the turn use, so there is one pill and one story."""
    verdicts: Dict[str, str] = {}
    if not is_running():
        return verdicts
    # The router's live view, never db.json: 0.3.60 persists lazily, and the file said a login expired on 08-30 while the router held one good until 09-17.
    due = connections_due(await process.get_providers(), now, lent_connection_ids())
    if not due:
        return verdicts
    async with httpx.AsyncClient(timeout=TEST_TIMEOUT_S) as client:
        for c in due:
            provider = str(c.get("provider") or "")
            answer = await test_connection(client, str(c.get("id") or ""))
            v = verdict_from_test(answer)
            verdicts[provider] = v
            if v == "unknown":
                note_unknown(provider, answer)
            if v == "refreshed":
                logger.info(f"[oauth-refresh] {provider}: token renewed ahead of expiry")
            elif v == "dead":
                logger.warning(f"[oauth-refresh] {provider}: the router could not renew this login; reporting it dead")
                from backend.apps.nine_router.subscription_health import report_dead_now
                await report_dead_now(provider)
    return verdicts


@typechecked
def refresh_held_because() -> Optional[str]:
    """A declared off switch (a drill beside the user's router must not renew the user's real logins), never an
    incidental one; when it holds, the log says which protection just stood down."""
    import os
    from backend.apps.agents.manager.session.SessionPersistence import running_under_test
    if os.environ.get("OSW_DISABLE_OAUTH_REFRESH") == "1":
        return "OSW_DISABLE_OAUTH_REFRESH=1"
    if running_under_test():
        return "the test harness"
    return None


async def oauth_refresh_loop() -> None:
    held = refresh_held_because()
    if held:
        logger.warning(f"[oauth-refresh] NOT renewing subscription logins because {held}; a login that expires while this process runs will only be reported after its first failed chat")
        return
    while True:
        try:
            await refresh_pass()
        except Exception:
            logger.exception("oauth refresh pass failed")
        await asyncio.sleep(CHECK_INTERVAL_S)
