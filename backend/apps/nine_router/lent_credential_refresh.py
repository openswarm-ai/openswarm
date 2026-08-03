"""Keeping this device usable while the cloud holds custody of a provider credential.

Handing a credential to the cloud strips the local refresh token on purpose: exactly one
holder may rotate it. 9Router's refresh dispatcher then bails on the falsy refreshToken
without calling the provider, so nothing renews the access token and every local call
starts failing a few hours after the handover, with no error that explains why.

This is the other half of that trade. The cloud rotates; this device asks the cloud for a
fresh access token shortly before the current one dies. Only lent connections are touched:
one that still holds a refresh token is 9Router's job and must be left alone.

Deliberately lazy. Each pull rewrites db.json, which means stopping the router and starting
it again, so we act only inside the margin and never on a fixed cadence.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import List, Optional

from typeguard import typechecked

from backend.apps.nine_router import credential_lease, credential_store

logger = logging.getLogger(__name__)

# Pull this far ahead of expiry. Wide enough that a failure leaves room for several retries
# before anything 401s, narrow enough that we are not restarting the router for fun.
REFRESH_MARGIN_S = 15 * 60
CHECK_INTERVAL_S = 120.0
# A dead network would otherwise mean a router restart every two minutes forever.
FAILURE_BACKOFF_S = 900.0


@typechecked
def p_seconds_left(expires_at: Optional[str]) -> Optional[float]:
    """Seconds until this token dies, or None when the timestamp is unreadable."""
    ms = credential_lease.expires_ms(expires_at)
    if ms <= 0:
        return None
    return (ms / 1000.0) - time.time()


@typechecked
def lent_connections_needing_a_pull() -> List[str]:
    """Connections the cloud holds whose access token is spent or nearly so.

    A missing refresh token is what marks a connection as lent, and an unreadable expiry is
    treated as due: better one wasted pull than a token that quietly stops working.
    """
    due: List[str] = []
    for connection_id in credential_store.list_oauth_connection_ids():
        cred = credential_store.read_credential(connection_id)
        if cred is None or cred.refresh_token:
            continue
        left = p_seconds_left(cred.expires_at)
        if left is None or left <= REFRESH_MARGIN_S:
            due.append(connection_id)
    return due


# A pull rewrites db.json, which stops and restarts the router, so two of them racing the same
# connection is not just wasteful: it is two writers on one file, and one edit loses.
p_in_flight: set[str] = set()


@typechecked
async def refresh_lent_credentials() -> int:
    """Top up every lent connection that needs it. Returns how many are now good."""
    refreshed = 0
    for connection_id in lent_connections_needing_a_pull():
        if connection_id in p_in_flight:
            continue
        p_in_flight.add(connection_id)
        try:
            outcome = await credential_lease.pull_access_token(connection_id)
        finally:
            p_in_flight.discard(connection_id)
        if outcome.status == "refreshed":
            refreshed += 1
            continue
        # Never the token itself, only why we could not get one.
        logger.warning(
            "could not renew the cloud-held credential %s: %s %s",
            connection_id,
            outcome.status,
            outcome.detail,
        )
    return refreshed


@typechecked
async def lent_credential_loop() -> None:
    while True:
        delay = CHECK_INTERVAL_S
        try:
            due = lent_connections_needing_a_pull()
            if due and await refresh_lent_credentials() == 0:
                delay = FAILURE_BACKOFF_S
        except Exception:
            logger.exception("lent-credential refresh pass failed")
            delay = FAILURE_BACKOFF_S
        await asyncio.sleep(delay)
